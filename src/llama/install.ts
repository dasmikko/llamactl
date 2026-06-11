/**
 * The install manager: owns the registry of built llama.cpp installs and runs
 * builds in the background. It mirrors the DownloadManager's shape — a per-job
 * AbortController, a FIFO queue with a concurrency cap, and a grace period during
 * which finished jobs linger in `builds()` — but builds are heavy, so concurrency
 * is 1 (extra builds queue).
 *
 * The active install supplies the `llama-server` binary the supervisor spawns;
 * the daemon reads `getActive()?.binPath`. The manager talks to the rest of the
 * app only through the frozen `IInstallManager` seam in `../types.ts`.
 */

import { mkdir, rm } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

import type {
  BuildJob,
  BuildRequest,
  IInstallManager,
  LlamaBackend,
  LlamaInstall,
} from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { BuildCanceledError, DEFAULT_LLAMA_REPO, defaultRunner, runBuild } from "./build.ts";
import type { BuildRunner } from "./build.ts";
import { InstallRegistry, loadRegistry } from "./registry.ts";

export interface InstallManagerOptions {
  /** Root dir holding one subdir per install (`<installsDir>/<id>`). */
  installsDir: string;
  /** Path to the registry JSON file. */
  registryPath: string;
  /** Persisted active id from config; overrides the registry's stored active id. */
  initialActiveId: string | null;
  /** Command runner seam; defaults to the real Bun-backed runner. */
  runner?: BuildRunner;
  /** Max lines kept in a job's logTail. Default 200. */
  logTailLines?: number;
  /** How long finished (ready/canceled) jobs linger in builds(). Default 60000 ms. */
  clearAfterMs?: number;
}

/** Internal bookkeeping for one tracked build. */
interface Entry {
  /** The user-facing snapshot, mutated in place as the build progresses. */
  record: BuildJob;
  /** Aborts the build (and its child process) when canceled. */
  controller: AbortController;
}

export class InstallManager implements IInstallManager {
  private readonly installsRoot: string;
  private readonly registry: InstallRegistry;
  private readonly runner: BuildRunner;
  private readonly logTailLines: number;
  private readonly clearAfterMs: number;

  /** All builds ever seen this process, keyed by job/install id. */
  private readonly entries = new Map<string, Entry>();
  /** FIFO queue of ids waiting for the single build slot. */
  private readonly queue: string[] = [];
  /** Whether a build currently holds the (size-1) slot. */
  private active = false;

  private constructor(opts: InstallManagerOptions, registry: InstallRegistry) {
    this.installsRoot = opts.installsDir;
    this.registry = registry;
    this.runner = opts.runner ?? defaultRunner();
    this.logTailLines = opts.logTailLines ?? 200;
    this.clearAfterMs = opts.clearAfterMs ?? 60000;
  }

  /**
   * Load the registry and construct a manager. A non-null `initialActiveId`
   * overrides the persisted active id (config wins over the registry file).
   */
  static async load(opts: InstallManagerOptions): Promise<InstallManager> {
    const registry = await loadRegistry(opts.registryPath);
    if (opts.initialActiveId !== null) registry.setActiveId(opts.initialActiveId);
    return new InstallManager(opts, registry);
  }

  /* ----------------------------------------------------------------------- */
  /* IInstallManager surface                                                 */
  /* ----------------------------------------------------------------------- */

  installs(): LlamaInstall[] {
    return this.registry.list();
  }

  builds(): BuildJob[] {
    return [...this.entries.values()]
      .map((e) => e.record)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  getActive(): LlamaInstall | null {
    const id = this.registry.getActiveId();
    return id ? (this.registry.get(id) ?? null) : null;
  }

  start(req: BuildRequest): BuildJob {
    const repo = req.repo && req.repo.trim().length > 0 ? req.repo.trim() : DEFAULT_LLAMA_REPO;
    const ref = req.ref && req.ref.length > 0 ? req.ref : "master";
    const backend: LlamaBackend = req.backend ?? "cuda";
    const allowUnsupportedCompiler = req.allowUnsupportedCompiler ?? false;
    const cudaHostCompiler =
      req.cudaHostCompiler && req.cudaHostCompiler.trim().length > 0
        ? req.cudaHostCompiler.trim()
        : null;
    const id = this.uniqueId(req.name, repo, ref);
    const name = req.name && req.name.length > 0 ? req.name : id;

    const record: BuildJob = {
      id,
      name,
      repo,
      ref,
      backend,
      allowUnsupportedCompiler,
      cudaHostCompiler,
      status: "queued",
      logTail: [],
      logPath: this.logPathFor(id),
      error: null,
      installId: null,
      startedAt: Date.now(),
    };
    const entry: Entry = { record, controller: new AbortController() };
    this.entries.set(id, entry);
    this.queue.push(id);
    this.pump();
    return record;
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new LlamactlError("install_not_found", `no build with id "${id}"`, { detail: { id } });
    }
    entry.controller.abort();
    // A still-queued build will never run; mark it canceled now.
    if (!this.active || this.queue.includes(id)) {
      const idx = this.queue.indexOf(id);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        if (!isTerminal(entry.record.status)) {
          entry.record.status = "canceled";
          this.scheduleRemoval(id);
        }
      }
    }
  }

  async setActive(id: string | null): Promise<void> {
    if (id !== null && !this.registry.get(id)) {
      throw new LlamactlError("install_not_found", `no install with id "${id}"`, { detail: { id } });
    }
    this.registry.setActiveId(id);
    await this.registry.save();
  }

  async remove(id: string): Promise<void> {
    const install = this.registry.get(id);
    const entry = this.entries.get(id);
    if (!install && !entry) {
      throw new LlamactlError("install_not_found", `no install or build with id "${id}"`, {
        detail: { id },
      });
    }

    // A tracked build (e.g. a failed one) is dismissed: abort it if still
    // running, drop the record, and delete its log. This is how failed builds
    // are cleared from the list.
    if (entry) {
      entry.controller.abort();
      this.entries.delete(id);
      await rm(this.logPathFor(id), { force: true }).catch(() => {});
    }

    if (install) {
      this.registry.remove(id); // also clears active if it was active
      await this.registry.save();
    }
    await rm(join(this.installsRoot, id), { recursive: true, force: true });
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ----------------------------------------------------------------------- */

  /** Derive a unique slug from a name (or repo+ref), suffixing on collision. */
  private uniqueId(name: string | undefined, repo: string, ref: string): string {
    const base = slug(name && name.length > 0 ? name : `${repoName(repo)}-${ref}`);
    if (!this.idTaken(base)) return base;
    // Append a short, monotonic suffix; Date.now() is allowed in this repo.
    let candidate = `${base}-${Date.now().toString(36)}`;
    let n = 1;
    while (this.idTaken(candidate)) candidate = `${base}-${Date.now().toString(36)}-${n++}`;
    return candidate;
  }

  /** Whether an id is already used by an install or a tracked build. */
  private idTaken(id: string): boolean {
    return this.registry.get(id) !== undefined || this.entries.has(id);
  }

  /** Start the queued build if the single slot is free. */
  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const entry = this.entries.get(id);
    if (!entry) {
      this.pump();
      return;
    }
    // Skip builds canceled while queued.
    if (isTerminal(entry.record.status)) {
      this.pump();
      return;
    }
    this.active = true;
    void this.run(entry).finally(() => {
      this.active = false;
      this.pump();
    });
  }

  /** Run a build to completion, mirroring progress onto the record. */
  private async run(entry: Entry): Promise<void> {
    const { record, controller } = entry;
    const installDir = join(this.installsRoot, record.id);

    // Persist the full build log to a file beside the install dir so it survives
    // the cleanup of a failed build's (partial) dir and can be opened in full.
    let logStream: WriteStream | null = null;
    try {
      await mkdir(this.installsRoot, { recursive: true });
      logStream = createWriteStream(record.logPath, { flags: "w" });
    } catch {
      logStream = null; // best-effort; logTail still captures recent lines
    }
    const onLine = (line: string): void => {
      this.appendLog(record, line);
      logStream?.write(line + "\n");
    };

    try {
      const result = await runBuild({
        repo: record.repo,
        ref: record.ref,
        backend: record.backend,
        allowUnsupportedCompiler: record.allowUnsupportedCompiler,
        cudaHostCompiler: record.cudaHostCompiler,
        installDir,
        runner: this.runner,
        signal: controller.signal,
        onStatus: (s) => {
          record.status = s;
        },
        onLine,
      });

      const install: LlamaInstall = {
        id: record.id,
        name: record.name,
        repo: record.repo,
        ref: record.ref,
        commit: result.commit,
        backend: record.backend,
        binPath: result.binPath,
        version: result.version,
        builtAt: Date.now(),
        sizeBytes: result.sizeBytes,
      };
      this.registry.add(install);
      // First successful install becomes active automatically.
      if (this.registry.getActiveId() === null) this.registry.setActiveId(install.id);
      await this.registry.save();

      record.status = "ready";
      record.installId = install.id;
      this.scheduleRemoval(record.id);
    } catch (e) {
      if (e instanceof BuildCanceledError) {
        // The user aborted: discard the partial checkout (and its log).
        record.status = "canceled";
        await rm(installDir, { recursive: true, force: true }).catch(() => {});
        this.scheduleRemoval(record.id);
        return;
      }
      record.status = "error";
      record.error = e instanceof Error ? e.message : String(e);
      // Append the reason to the log so it's the last thing the user sees.
      onLine(`\n*** build failed: ${record.error}`);
      // Keep the source + build tree on failure so the user can inspect why it
      // failed and retry; "error" jobs stay visible and `install rm <id>` clears
      // the dir when they're done.
    } finally {
      logStream?.end();
    }
  }

  /** Path to a build's persistent log file (beside, not inside, the install dir). */
  private logPathFor(id: string): string {
    return join(this.installsRoot, `${id}.log`);
  }

  /** Push a line onto a job's capped logTail, dropping the oldest when full. */
  private appendLog(record: BuildJob, line: string): void {
    record.logTail.push(line);
    if (record.logTail.length > this.logTailLines) {
      record.logTail.splice(0, record.logTail.length - this.logTailLines);
    }
  }

  /** Drop a finished non-error job from builds() after the grace period. */
  private scheduleRemoval(id: string): void {
    if (this.clearAfterMs <= 0) return;
    setTimeout(() => {
      const e = this.entries.get(id);
      // Keep "error" jobs (and their logs); only clear ready/canceled.
      if (e && (e.record.status === "ready" || e.record.status === "canceled")) {
        this.entries.delete(id);
        void rm(this.logPathFor(id), { force: true }).catch(() => {});
      }
    }, this.clearAfterMs);
  }
}

/** Whether a build status is terminal (no further work will run). */
function isTerminal(status: BuildJob["status"]): boolean {
  return status === "ready" || status === "error" || status === "canceled";
}

/** Lowercase, dash-separated slug; safe as a directory name. */
function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.length > 0 ? out : "install";
}

/** Last path segment of a git repo url, stripped of `.git`. */
function repoName(repo: string): string {
  const tail = repo.replace(/\/+$/, "").split("/").pop() ?? repo;
  return tail.replace(/\.git$/, "");
}
