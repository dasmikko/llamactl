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
  Model,
  ModelResolver,
  RunningModel,
} from "../types.ts";
import { BunstashError } from "../errors.ts";
import { findFreePort } from "../net/ports.ts";

export interface SupervisorOptions {
  config: Config;
  resolver: ModelResolver;
  /** Per-launch logs go here. */
  logsDir: string;
  /** Already-resolved binary path to spawn. */
  llamaServerPath: string;
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
  /** Context size this child was launched with. */
  ctx: number;
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

export class Supervisor implements ISupervisor {
  private readonly config: Config;
  private readonly resolver: ModelResolver;
  private readonly logsDir: string;
  private readonly llamaServerPath: string;
  private readonly spawnPrefix: string[];
  private readonly portBase: number;
  private readonly retryCap: number;
  private readonly retryWindowMs: number;
  private readonly readinessTimeoutMs: number;

  private readonly children = new Map<string, Entry>();
  private shuttingDown = false;

  constructor(opts: SupervisorOptions) {
    this.config = opts.config;
    this.resolver = opts.resolver;
    this.logsDir = opts.logsDir;
    this.llamaServerPath = opts.llamaServerPath;
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

  async start(selector: string, ctx?: number): Promise<RunningModel> {
    const model = this.resolver.resolve(selector); // may throw model_not_found / ambiguous_model

    if (this.children.has(model.id)) {
      throw new BunstashError(
        "already_running",
        `Model "${model.id}" is already running.`,
        { detail: { modelId: model.id } },
      );
    }

    // Only validate the path when it looks like a filesystem path (not a bare
    // command resolved from PATH). Absolute or explicitly relative paths must
    // exist; a bare binary name is left to spawn to resolve.
    if (this.looksLikePath(this.llamaServerPath) && !existsSync(this.llamaServerPath)) {
      throw new BunstashError(
        "llama_server_missing",
        `llama-server binary not found at "${this.llamaServerPath}".`,
        { detail: { path: this.llamaServerPath } },
      );
    }

    const resolvedCtx = ctx ?? this.config.defaultCtx;
    const entry = await this.spawnChild(model, resolvedCtx);
    this.children.set(model.id, entry);
    return entry.model;
  }

  async ensureReady(selector: string, ctx?: number): Promise<RunningModel> {
    const model = this.resolver.resolve(selector);
    let entry = this.children.get(model.id);
    if (!entry) {
      await this.start(model.id, ctx);
      entry = this.children.get(model.id);
    }
    if (!entry) {
      // Resolution succeeded but the child vanished immediately (e.g. crashed
      // and exceeded the cap during start). Surface a launch failure.
      throw new BunstashError(
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
        throw new BunstashError(
          "launch_failed",
          `Model "${model.id}" is no longer running.`,
          { detail: { modelId: model.id } },
        );
      }

      if (current.model.status === "crashed") {
        throw new BunstashError(
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
    throw new BunstashError(
      "launch_failed",
      `Model "${model.id}" did not become ready within ${this.readinessTimeoutMs}ms.`,
      { detail: { modelId: model.id } },
    );
  }

  async stop(selector: string): Promise<RunningModel> {
    const entry = this.findEntry(selector);
    if (!entry) {
      throw new BunstashError("not_running", `No running model for "${selector}".`, {
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

  /** Spawn a child for `model`, wire up the exit handler, return the Entry. */
  private async spawnChild(model: Model, ctx: number): Promise<Entry> {
    const port = await findFreePort(this.portBase, "127.0.0.1");
    const startedAt = Date.now();
    const logPath = join(this.logsDir, `${model.id}-${startedAt}.log`);

    const cmd = [
      ...this.spawnPrefix,
      this.llamaServerPath,
      "-m",
      model.path,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ctx-size",
      String(ctx),
      ...this.config.llamaServerArgs,
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
      throw new BunstashError(
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
    };

    const entry: Entry = {
      model: running,
      resolved: model,
      ctx,
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
      port = await findFreePort(this.portBase, "127.0.0.1");
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
      this.llamaServerPath,
      "-m",
      entry.resolved.path,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ctx-size",
      String(entry.ctx),
      ...this.config.llamaServerArgs,
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
