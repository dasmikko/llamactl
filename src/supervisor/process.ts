/**
 * Process supervisor: spawns and babysits `llama-server` children. Each model
 * id maps to at most one child. The supervisor assigns a free loopback port,
 * routes stdout/stderr to a per-launch log file, polls `/health` for readiness,
 * and restarts crashed children up to a capped rate before giving up.
 *
 * The proxy and control plane depend only on the `ISupervisor` seam in
 * `../types.ts`; this concrete class is the Phase 4 implementation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  Config,
  ISupervisor,
  LaunchSpec,
  LlamaServerInfo,
  LlamaServerSpec,
  Model,
  ModelResolver,
  RunningModel,
} from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { findFreePort, isPortFree } from "../net/ports.ts";
import { applyDefaults, specToArgs, validateSpec } from "../instances/spec.ts";
import { findMtpHead } from "../discovery/models.ts";
import { parseLlamaHelp } from "../llama/help.ts";

export interface SupervisorOptions {
  config: Config;
  resolver: ModelResolver;
  /** Per-launch logs go here. */
  logsDir: string;
  /**
   * The `llama-server` binary to spawn. A bare string is fixed; a getter is
   * re-read on every spawn/probe so switching the active managed install takes
   * effect for new (re)starts without restarting the daemon.
   */
  llamaServerPath: string | (() => string);
  /** Prepended to argv (default []); tests use [process.execPath]. */
  spawnPrefix?: string[];
  /** First port to try when assigning a child a loopback port. Default 18000. */
  portBase?: number;
  /** Max restarts allowed within the retry window. Default 3. */
  retryCap?: number;
  /** Sliding window (ms) over which restarts are counted. Default 60000. */
  retryWindowMs?: number;
  /** How long to wait for `/health` to go 200 before failing. Default 60000. */
  readinessTimeoutMs?: number;
}

type Subprocess = ReturnType<typeof Bun.spawn>;

/** Internal bookkeeping for one supervised child. */
interface Entry {
  /** The user-facing snapshot. Mutated in place as state changes. */
  model: RunningModel;
  /** The resolved Model (path/name/etc) so we can respawn without re-resolving. */
  resolved: Model;
  /** The fully-defaulted spec this child was launched with. */
  spec: LaunchSpec;
  /** The live child process handle. */
  proc: Subprocess;
  /** True while a deliberate stop is in progress (suppresses crash handling). */
  stopping: boolean;
  /** Epoch-ms timestamps of recent exits, within the retry window. */
  exitTimes: number[];
  /** Reason recorded when the entry transitions to "crashed". */
  crashReason?: string;
}

const GRACE_MS = 3000;

/** Cap on startup warnings kept per child, so a noisy log can't flood the UI. */
const MAX_WARNINGS = 12;

/**
 * Pull the warning/error lines out of a llama-server log.
 *
 * llama-server fails soft on plenty of misconfiguration — a missing MTP head,
 * `--gpu-layers` on a build without GPU support — logging a warning and serving
 * anyway. The result looks healthy while quietly not doing what was asked, so
 * these get lifted onto the RunningModel for the TUI.
 *
 * Two line shapes are recognised: llama.cpp's timestamped `0.00.704.443 W msg`
 * (and its `E` counterpart), and the bare `warning:` / `error:` lines printed
 * before its logger is up. Pure so it can be tested against fixtures.
 */
export function parseLogWarnings(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const stamped = line.match(/^\d+\.\d+\.\d+(?:\.\d+)?\s+([WE])\s+(.*)$/);
    if (stamped) out.push(`${stamped[1] === "E" ? "error" : "warning"}: ${stamped[2]!.trim()}`);
    else if (/^(warning|error):/i.test(line)) out.push(line);
    if (out.length >= MAX_WARNINGS) break;
  }
  return [...new Set(out)];
}

/** {@link parseLogWarnings} over a log file. Best-effort: unreadable ⇒ none. */
async function scanLogWarnings(logPath: string): Promise<string[]> {
  try {
    return parseLogWarnings(await Bun.file(logPath).text());
  } catch {
    return [];
  }
}

export class Supervisor implements ISupervisor {
  private readonly config: Config;
  private readonly resolver: ModelResolver;
  private readonly logsDir: string;
  /** Re-read on each spawn/probe so an active-install switch is picked up. */
  private readonly resolveBin: () => string;
  private readonly spawnPrefix: string[];
  private readonly portBase: number;
  private readonly retryCap: number;
  private readonly retryWindowMs: number;
  private readonly readinessTimeoutMs: number;

  private readonly children = new Map<string, Entry>();
  private shuttingDown = false;
  /** Cached `llama-server` probes, keyed by resolved binary path (it can change). */
  private readonly serverProbes = new Map<string, Promise<LlamaServerInfo>>();
  /** Cached `--help` flag parses, keyed by resolved binary path. */
  private readonly flagProbes = new Map<string, Promise<LlamaServerSpec>>();

  constructor(opts: SupervisorOptions) {
    this.config = opts.config;
    this.resolver = opts.resolver;
    this.logsDir = opts.logsDir;
    this.resolveBin =
      typeof opts.llamaServerPath === "function"
        ? opts.llamaServerPath
        : () => opts.llamaServerPath as string;
    this.spawnPrefix = opts.spawnPrefix ?? [];
    this.portBase = opts.portBase ?? 18000;
    this.retryCap = opts.retryCap ?? 3;
    this.retryWindowMs = opts.retryWindowMs ?? 60000;
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 60000;
  }

  list(): RunningModel[] {
    return [...this.children.values()].map((e) => e.model);
  }

  get(modelId: string): RunningModel | undefined {
    return this.children.get(modelId)?.model;
  }

  async start(spec: LaunchSpec): Promise<RunningModel> {
    validateSpec(spec);
    const model = this.resolver.resolve(spec.model); // may throw model_not_found / ambiguous_model

    if (this.children.has(model.id)) {
      throw new LlamactlError(
        "already_running",
        `Model "${model.id}" is already running.`,
        { detail: { modelId: model.id } },
      );
    }

    // Only validate the path when it looks like a filesystem path (not a bare
    // command resolved from PATH). Absolute or explicitly relative paths must
    // exist; a bare binary name is left to spawn to resolve.
    const bin = this.resolveBin();
    if (this.looksLikePath(bin) && !existsSync(bin)) {
      throw new LlamactlError(
        "llama_server_missing",
        `llama-server binary not found at "${bin}".`,
        { detail: { path: bin } },
      );
    }

    const resolvedSpec = this.resolveDraftModel(model, applyDefaults(spec, this.config));
    const entry = await this.spawnChild(model, resolvedSpec);
    this.children.set(model.id, entry);
    // Proactively watch /health in the background so the status flips to
    // "ready" on its own — nothing else polls it now that the proxy is gone.
    this.beginReadinessProbe(entry);
    return entry.model;
  }

  async ensureReady(spec: LaunchSpec): Promise<RunningModel> {
    const model = this.resolver.resolve(spec.model);
    let entry = this.children.get(model.id);
    if (!entry) {
      await this.start(spec);
      entry = this.children.get(model.id);
    }
    if (!entry) {
      // Resolution succeeded but the child vanished immediately (e.g. crashed
      // and exceeded the cap during start). Surface a launch failure.
      throw new LlamactlError(
        "launch_failed",
        `Model "${model.id}" failed to launch.`,
        { detail: { modelId: model.id } },
      );
    }

    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      // The entry may be replaced across a restart, so re-read each loop.
      const current = this.children.get(model.id);

      if (!current) {
        // Child was removed (stopped or shut down) out from under us.
        throw new LlamactlError(
          "launch_failed",
          `Model "${model.id}" is no longer running.`,
          { detail: { modelId: model.id } },
        );
      }

      if (current.model.status === "crashed") {
        throw new LlamactlError(
          "restart_cap_exceeded",
          `Model "${model.id}" crashed too many times: ${current.crashReason ?? "unknown"}.`,
          { detail: { modelId: model.id, reason: current.crashReason } },
        );
      }

      if (await this.probeHealth(current.model.port)) {
        current.model.status = "ready";
        return current.model;
      }

      await delay(100);
    }

    // Timed out waiting for readiness. Tear the child down so we don't leak it.
    try {
      await this.stop(model.id);
    } catch {
      /* already gone */
    }
    throw new LlamactlError(
      "launch_failed",
      `Model "${model.id}" did not become ready within ${this.readinessTimeoutMs}ms.`,
      { detail: { modelId: model.id } },
    );
  }

  async stop(selector: string): Promise<RunningModel> {
    const entry = this.findEntry(selector);
    if (!entry) {
      throw new LlamactlError("not_running", `No running model for "${selector}".`, {
        detail: { selector },
      });
    }

    entry.stopping = true;
    entry.model.status = "stopping";
    this.children.delete(entry.model.modelId);

    await this.terminate(entry.proc);
    return entry.model;
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.children.values()];
    this.children.clear();
    for (const e of entries) {
      e.stopping = true;
      e.model.status = "stopping";
    }
    await Promise.all(entries.map((e) => this.terminate(e.proc)));
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Allocate the loopback port for a spec: honour a pinned `spec.port` (failing
   * cleanly if it is busy), otherwise scan upward from `portBase`.
   */
  private async allocatePort(spec: LaunchSpec): Promise<number> {
    const host = spec.host ?? "127.0.0.1";
    if (spec.port !== undefined) {
      if (!(await isPortFree(spec.port, host))) {
        throw new LlamactlError(
          "launch_failed",
          `Port ${spec.port} is already in use.`,
          { detail: { port: spec.port } },
        );
      }
      return spec.port;
    }
    return findFreePort(this.portBase, host);
  }

  /**
   * Report the `llama-server` binary (path / found / version), detected once and
   * cached — the resolved binary doesn't change over the daemon's lifetime.
   */
  serverInfo(): Promise<LlamaServerInfo> {
    const bin = this.resolveBin();
    let probe = this.serverProbes.get(bin);
    if (!probe) {
      probe = this.probeServer(bin);
      this.serverProbes.set(bin, probe);
    }
    return probe;
  }

  private async probeServer(path: string): Promise<LlamaServerInfo> {
    // A path-like value must exist on disk; a bare command is looked up on PATH.
    const found = this.looksLikePath(path) ? existsSync(path) : Bun.which(path) !== null;
    if (!found) return { path, found: false };
    return { path, found: true, version: await this.runVersionProbe(path) };
  }

  /**
   * Report the flags the binary accepts, parsed from `--help`, cached per binary
   * path. Empty flag list when the binary is missing or its help is unparseable.
   */
  serverFlags(): Promise<LlamaServerSpec> {
    const bin = this.resolveBin();
    let probe = this.flagProbes.get(bin);
    if (!probe) {
      probe = this.probeFlags(bin);
      this.flagProbes.set(bin, probe);
    }
    return probe;
  }

  private async probeFlags(bin: string): Promise<LlamaServerSpec> {
    const info = await this.serverInfo();
    const version = info.version ?? null;
    if (!info.found) return { version, flags: [] };
    const text = await this.runHelpProbe(bin);
    return { version, flags: parseLlamaHelp(text) };
  }

  private async runHelpProbe(bin: string): Promise<string> {
    try {
      const proc = Bun.spawn({
        cmd: [...this.spawnPrefix, bin, "--help"],
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      // Guard against a binary that ignores --help and tries to serve forever.
      const kill = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      clearTimeout(kill);
      return out + err;
    } catch {
      return "";
    }
  }

  private async runVersionProbe(bin: string): Promise<string | undefined> {
    try {
      const proc = Bun.spawn({
        cmd: [...this.spawnPrefix, bin, "--version"],
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      // Guard against a binary that ignores --version and tries to serve forever.
      const kill = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      clearTimeout(kill);
      return parseVersion(out + err);
    } catch {
      return undefined;
    }
  }

  /** Spawn a child for `model`, wire up the exit handler, return the Entry. */
  private async spawnChild(model: Model, spec: LaunchSpec): Promise<Entry> {
    const port = await this.allocatePort(spec);
    const startedAt = Date.now();
    const logPath = join(this.logsDir, `${model.id}-${startedAt}.log`);

    const cmd = [
      ...this.spawnPrefix,
      this.resolveBin(),
      ...specToArgs({ modelPath: model.path, port, spec, configArgs: this.config.llamaServerArgs }),
    ];

    const logFile = Bun.file(logPath);
    let proc: Subprocess;
    try {
      proc = Bun.spawn({
        cmd,
        env: { ...process.env },
        stdout: logFile,
        stderr: logFile,
        stdin: "ignore",
      });
    } catch (e) {
      throw new LlamactlError(
        "launch_failed",
        `Failed to spawn llama-server for "${model.id}": ${e instanceof Error ? e.message : String(e)}`,
        { detail: { modelId: model.id, cmd } },
      );
    }

    const running: RunningModel = {
      modelId: model.id,
      name: model.name,
      path: model.path,
      pid: proc.pid,
      port,
      status: "starting",
      startedAt,
      restarts: 0,
      logPath,
      spec,
      llamaServerVersion: (await this.serverInfo()).version,
    };

    const entry: Entry = {
      model: running,
      resolved: model,
      spec,
      proc,
      stopping: false,
      exitTimes: [],
    };

    this.attachExitHandler(entry);
    return entry;
  }

  /** Attach the crash/restart handler to the current process of `entry`. */
  private attachExitHandler(entry: Entry): void {
    const proc = entry.proc;
    void proc.exited.then((code) => {
      this.onExit(entry, proc, code);
    });
  }

  /** Handle a child exit: ignore deliberate stops, otherwise crash/restart. */
  private onExit(entry: Entry, proc: Subprocess, code: number): void {
    // Stale handler (the entry has since been replaced by a respawn).
    if (entry.proc !== proc) return;
    // Deliberate stop or daemon shutdown: not a crash.
    if (entry.stopping || this.shuttingDown) return;
    // Entry already removed (e.g. readiness timeout tore it down).
    if (this.children.get(entry.model.modelId) !== entry) return;

    const now = Date.now();
    entry.exitTimes.push(now);
    // Drop exits outside the sliding window.
    entry.exitTimes = entry.exitTimes.filter((t) => now - t <= this.retryWindowMs);

    // exitTimes.length is the number of crashes observed in the window. The
    // first crash is restart #1; we allow up to `retryCap` restarts.
    if (entry.exitTimes.length > this.retryCap) {
      entry.model.status = "crashed";
      entry.crashReason = `exited with code ${code} (exceeded restart cap of ${this.retryCap})`;
      // Leave the entry in the map so callers can observe the crashed status,
      // but do not respawn.
      return;
    }

    // Respawn: new free port, new log file, fresh process. Reuse the same Entry
    // so external references (and the map key) stay valid.
    void this.respawn(entry, code);
  }

  /** Respawn a crashed child in place, preserving its Entry identity. */
  private async respawn(entry: Entry, prevCode: number): Promise<void> {
    // Re-check guards: state may have changed while awaiting the free port.
    if (entry.stopping || this.shuttingDown) return;
    if (this.children.get(entry.model.modelId) !== entry) return;

    let port: number;
    try {
      port = await this.allocatePort(entry.spec);
    } catch {
      entry.model.status = "crashed";
      entry.crashReason = `could not allocate a port to restart after exit code ${prevCode}`;
      return;
    }

    if (entry.stopping || this.shuttingDown) return;
    if (this.children.get(entry.model.modelId) !== entry) return;

    const startedAt = Date.now();
    const logPath = join(this.logsDir, `${entry.resolved.id}-${startedAt}.log`);
    const cmd = [
      ...this.spawnPrefix,
      this.resolveBin(),
      ...specToArgs({
        modelPath: entry.resolved.path,
        port,
        spec: entry.spec,
        configArgs: this.config.llamaServerArgs,
      }),
    ];

    const logFile = Bun.file(logPath);
    let proc: Subprocess;
    try {
      proc = Bun.spawn({ cmd, env: { ...process.env }, stdout: logFile, stderr: logFile, stdin: "ignore" });
    } catch {
      entry.model.status = "crashed";
      entry.crashReason = `failed to respawn after exit code ${prevCode}`;
      return;
    }

    entry.proc = proc;
    entry.model.pid = proc.pid;
    entry.model.port = port;
    entry.model.status = "starting";
    entry.model.startedAt = startedAt;
    entry.model.logPath = logPath;
    entry.model.restarts += 1;
    this.attachExitHandler(entry);
    // A respawned child starts "starting" again — re-arm the readiness probe.
    this.beginReadinessProbe(entry);
  }

  /**
   * Fill in `--spec-draft-model` for MTP speculative decoding when the user
   * asked for it but didn't name a head file.
   *
   * `--spec-type draft-mtp` needs the model's MTP/NextN layers, and several
   * repos publish those as a separate GGUF beside the main quant. Point
   * llama.cpp at a model without them and it warns once and runs with
   * speculation silently disabled — so when discovery has found the matching
   * head, wire it up rather than let the launch quietly do nothing. An explicit
   * `specDraftModel` always wins; an unmatched head leaves the spec untouched.
   */
  private resolveDraftModel(model: Model, spec: LaunchSpec): LaunchSpec {
    if (spec.specDraftModel !== undefined && spec.specDraftModel !== "") return spec;
    const specType = spec.extraFlags?.["--spec-type"];
    if (typeof specType !== "string" || !specType.split(",").includes("draft-mtp")) return spec;

    const head = findMtpHead(this.resolver.all(), model);
    // Never point a model at itself: llama.cpp would load a second full copy of
    // the weights and OOM the device at load time. findMtpHead already excludes
    // it; this is the belt-and-braces check because the failure is expensive.
    if (!head || head.path === model.path) return spec;
    return { ...spec, specDraftModel: head.path };
  }

  /**
   * Poll `/health` in the background until the child reports ready, then flip
   * its status to "ready". Self-cancels if the entry is stopped, replaced,
   * crashes, or the readiness window elapses (a child that never serves health
   * but also never exits simply stays "starting"; the exit handler covers
   * actual crashes). Runs in addition to any blocking `ensureReady` caller.
   */
  private beginReadinessProbe(entry: Entry): void {
    const deadline = Date.now() + this.readinessTimeoutMs;
    const tick = async (): Promise<void> => {
      // Bail if this entry is no longer the live child for its id.
      if (this.children.get(entry.model.modelId) !== entry) return;
      if (entry.stopping || this.shuttingDown) return;
      if (entry.model.status !== "starting") return; // ready, crashed, or stopping

      if (await this.probeHealth(entry.model.port)) {
        // The child has finished loading, so its startup log is complete —
        // scrape the soft failures (missing MTP head, ignored --gpu-layers)
        // before flipping to a status that otherwise looks entirely healthy.
        const warnings = await scanLogWarnings(entry.model.logPath);
        // Re-check identity/state after the await before committing the flip.
        if (this.children.get(entry.model.modelId) === entry && entry.model.status === "starting") {
          if (warnings.length > 0) entry.model.warnings = warnings;
          entry.model.status = "ready";
        }
        return;
      }
      if (Date.now() < deadline) setTimeout(() => void tick(), 250);
    };
    setTimeout(() => void tick(), 100);
  }

  /** SIGTERM, wait up to GRACE_MS, then SIGKILL. Resolves when the child exits. */
  private async terminate(proc: Subprocess): Promise<void> {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    const exited = proc.exited;
    const timedOut = Symbol("timeout");
    const race = await Promise.race([
      exited.then(() => "exited" as const),
      delay(GRACE_MS).then(() => timedOut),
    ]);
    if (race === timedOut) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      await exited;
    }
  }

  /** GET /health; true on HTTP 200, false on non-200 or connection error. */
  private async probeHealth(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      // Drain the body so the connection can be reused/closed cleanly.
      await res.body?.cancel().catch(() => {});
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Resolve a selector to a tracked entry: direct id hit, else via resolver. */
  private findEntry(selector: string): Entry | undefined {
    const direct = this.children.get(selector);
    if (direct) return direct;
    let id: string | undefined;
    try {
      id = this.resolver.resolve(selector).id;
    } catch {
      return undefined;
    }
    return this.children.get(id);
  }

  /** Whether `p` should be treated as a filesystem path vs a PATH lookup. */
  private looksLikePath(p: string): boolean {
    return p.includes("/") || p.includes("\\");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a version from `llama-server --version` output. llama.cpp prints a
 * `version: <build> (<commit>)` line (to stderr); prefer that, else fall back to
 * the first non-empty line. Returns undefined when nothing usable is found.
 */
function parseVersion(text: string): string | undefined {
  const tagged = text.match(/^\s*version:\s*(.+?)\s*$/im);
  if (tagged?.[1]) return tagged[1].trim();
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine || undefined;
}
