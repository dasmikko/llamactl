/**
 * CLI command handlers. Each respects the --json contract: in JSON mode the
 * only stdout output is one machine-readable document. Human mode renders a
 * padded table on a TTY, TSV when piped.
 */

import type { Config, Model, RunningModel, PsResponse } from "../types.ts";
import { BunstashError, isBunstashError } from "../errors.ts";
import { discoverModels } from "../discovery/models.ts";
import { connectDaemon, currentRuntime, clientFor } from "./../daemon/client.ts";
import { readLiveRuntime, isProcessAlive, clearRuntime } from "../daemon/runtime.ts";
import {
  type Column,
  type OutputMode,
  emitError,
  emitJson,
  emitLine,
  humanBytes,
  humanUptime,
  renderTable,
} from "./output.ts";
import { type ParsedArgs, numOpt } from "./args.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------- list ------------------------------------ */

export async function cmdList(config: Config, mode: OutputMode): Promise<number> {
  const models = await discoverModels({ extraPaths: config.modelPaths });
  models.sort((a, b) => a.id.localeCompare(b.id));

  if (mode.json) {
    emitJson({ models });
    return 0;
  }

  if (models.length === 0) {
    emitLine("No GGUF models found. Add paths in your config or download one.");
    return 0;
  }

  const columns: Column<Model>[] = [
    { header: "ID", get: (m) => m.id },
    { header: "NAME", get: (m) => m.name },
    { header: "QUANT", get: (m) => m.quant ?? "-" },
    { header: "SIZE", get: (m) => humanBytes(m.sizeBytes), alignRight: true },
    { header: "SOURCE", get: (m) => m.source },
  ];
  emitLine(renderTable(models, columns, mode));
  return 0;
}

/* ------------------------------- start ----------------------------------- */

export async function cmdStart(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const selector = args.positionals[1];
  if (!selector) throw new BunstashError("bad_request", "usage: bunstash start <model>");
  const ctx = numOpt(args, "ctx");

  const conn = await connectDaemon({ config });
  const running = await conn.request<RunningModel>("POST", "/start", { model: selector, ctx });

  if (mode.json) {
    emitJson(running);
    return 0;
  }
  emitLine(`Started ${running.name} (${running.modelId}) on port ${running.port} [pid ${running.pid}]`);
  emitLine(`Point an OpenAI client at ${conn.runtime.proxyUrl}/v1 and request model "${running.modelId}".`);
  return 0;
}

/* -------------------------------- stop ----------------------------------- */

export async function cmdStop(args: ParsedArgs, _config: Config, mode: OutputMode): Promise<number> {
  const selector = args.positionals[1];
  if (!selector) throw new BunstashError("bad_request", "usage: bunstash stop <model>");

  const rt = await readLiveRuntime();
  if (!rt) {
    if (mode.json) {
      emitJson({ stopped: false, reason: "daemon_not_running" });
      return 0;
    }
    emitLine("Daemon is not running; nothing to stop.");
    return 0;
  }
  const conn = clientFor(rt);
  const stopped = await conn.request<RunningModel>("POST", "/stop", { model: selector });

  if (mode.json) {
    emitJson(stopped);
    return 0;
  }
  emitLine(`Stopped ${stopped.name} (${stopped.modelId}).`);
  return 0;
}

/* --------------------------------- ps ------------------------------------ */

export async function cmdPs(_config: Config, mode: OutputMode): Promise<number> {
  const rt = await readLiveRuntime();
  let running: RunningModel[] = [];
  if (rt) {
    const conn = clientFor(rt);
    const res = await conn.request<PsResponse>("GET", "/ps");
    running = res.running;
  }

  if (mode.json) {
    emitJson({ running });
    return 0;
  }

  if (running.length === 0) {
    emitLine(rt ? "No models running." : "Daemon is not running.");
    return 0;
  }

  const now = Date.now();
  const columns: Column<RunningModel>[] = [
    { header: "MODEL", get: (r) => r.modelId },
    { header: "PORT", get: (r) => String(r.port), alignRight: true },
    { header: "PID", get: (r) => String(r.pid), alignRight: true },
    { header: "STATUS", get: (r) => r.status },
    { header: "UPTIME", get: (r) => humanUptime(r.startedAt, now), alignRight: true },
    { header: "RESTARTS", get: (r) => String(r.restarts), alignRight: true },
  ];
  emitLine(renderTable(running, columns, mode));
  return 0;
}

/* ----------------------------- daemon start/stop ------------------------- */

export async function cmdDaemonStart(config: Config, mode: OutputMode): Promise<number> {
  const existing = await readLiveRuntime();
  if (existing) {
    if (mode.json) {
      emitJson({ status: "already_running", controlUrl: existing.controlUrl, proxyUrl: existing.proxyUrl });
      return 0;
    }
    emitLine(`Daemon already running (pid ${existing.pid}). Proxy at ${existing.proxyUrl}`);
    return 0;
  }

  // connectDaemon spawns the detached daemon and waits for runtime.json.
  const conn = await connectDaemon({ config });
  if (mode.json) {
    emitJson({
      status: "started",
      pid: conn.runtime.pid,
      controlUrl: conn.runtime.controlUrl,
      proxyUrl: conn.runtime.proxyUrl,
    });
    return 0;
  }
  emitLine(`Daemon started (pid ${conn.runtime.pid}).`);
  emitLine(`Proxy:         ${conn.runtime.proxyUrl}/v1`);
  emitLine(`Control plane: ${conn.runtime.controlUrl} (loopback, token-guarded)`);
  return 0;
}

export async function cmdDaemonStop(mode: OutputMode): Promise<number> {
  const rt = await currentRuntime();
  if (!rt) {
    if (mode.json) {
      emitJson({ stopped: false, reason: "not_running" });
      return 0;
    }
    emitLine("Daemon is not running.");
    return 0;
  }

  // Ask the daemon to shut down via SIGTERM, then wait for it to clear runtime.json.
  try {
    process.kill(rt.pid, "SIGTERM");
  } catch {
    // Already gone; fall through to cleanup.
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(rt.pid)) break;
    await sleep(100);
  }
  // Best-effort: if the process is gone but the file lingers, clear it.
  if (!isProcessAlive(rt.pid)) await clearRuntime();

  if (mode.json) {
    emitJson({ stopped: true, pid: rt.pid });
    return 0;
  }
  emitLine(`Daemon stopped (pid ${rt.pid}).`);
  return 0;
}

/* ----------------------------- stubs (Phase 8) --------------------------- */

function stub(name: string, mode: OutputMode, note: string): number {
  if (mode.json) {
    emitJson({ command: name, status: "not_implemented", note });
    return 0;
  }
  emitLine(`'${name}' is not implemented yet — ${note}`);
  return 0;
}

export function cmdInit(mode: OutputMode): number {
  return stub("init", mode, "interactive setup wizard arrives in a later phase.");
}
export function cmdRecommend(mode: OutputMode): number {
  return stub("recommend", mode, "model recommendations arrive in a later phase.");
}
export function cmdDoctor(mode: OutputMode): number {
  return stub("doctor", mode, "environment diagnostics arrive in a later phase.");
}

/* ------------------------------- error sink ------------------------------ */

/** Render a caught error per the output mode and return a process exit code. */
export function reportError(e: unknown, mode: OutputMode): number {
  const err = isBunstashError(e)
    ? e
    : new BunstashError("internal", e instanceof Error ? e.message : String(e));
  if (mode.json) {
    emitJson(err.toApiError());
  } else {
    emitError(`error[${err.code}]: ${err.message}`);
  }
  return 1;
}
