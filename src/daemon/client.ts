/**
 * CLI -> daemon client. Reads runtime.json to find the control plane; if it's
 * absent or stale (dead PID), forks a detached daemon, waits for a fresh
 * runtime.json, and retries once. All requests carry the bearer token.
 */

import type { Config, Runtime } from "../types.ts";
import type { ApiError } from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { readLiveRuntime, isProcessAlive } from "./runtime.ts";

/** Build the argv that re-launches this same program with extra args. */
function selfArgs(extra: string[]): string[] {
  // In a compiled binary Bun.main is the executable (no .ts/.js extension); in
  // dev it's the entry script that must be passed back to the bun runtime.
  const compiled = !/\.(ts|js|mjs|cjs)$/.test(Bun.main);
  const base = compiled ? [process.execPath] : [process.execPath, Bun.main];
  return [...base, ...extra];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spawn the daemon as a detached background process and unref it. */
function spawnDaemon(): void {
  const child = Bun.spawn({
    cmd: selfArgs(["daemon", "__run"]),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, LLAMACTL_DAEMON_CHILD: "1" },
  });
  // Let the parent CLI exit independently of the daemon.
  child.unref();
}

/** Poll for a live runtime.json for up to `timeoutMs`. */
async function awaitRuntime(timeoutMs: number): Promise<Runtime | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rt = await readLiveRuntime();
    if (rt) return rt;
    await sleep(100);
  }
  return null;
}

export interface DaemonConnection {
  runtime: Runtime;
  /** Make an authenticated control-plane request and parse the JSON result. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Wrap a Runtime in a small authenticated client. */
export function clientFor(runtime: Runtime): DaemonConnection {
  return {
    runtime,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let res: Response;
      try {
        res = await fetch(runtime.controlUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${runtime.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        throw new LlamactlError(
          "daemon_unreachable",
          `could not reach the daemon at ${runtime.controlUrl}: ${(e as Error).message}`,
        );
      }
      const text = await res.text();
      if (!res.ok) {
        // Surface the daemon's typed error if present.
        try {
          const parsed = JSON.parse(text) as ApiError;
          if (parsed?.error?.code) {
            throw new LlamactlError(parsed.error.code, parsed.error.message, {
              detail: parsed.error.detail,
              httpStatus: res.status,
            });
          }
        } catch (e) {
          if (e instanceof LlamactlError) throw e;
        }
        throw new LlamactlError("internal", `daemon returned HTTP ${res.status}: ${text}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}

/**
 * Connect to the daemon, spawning it if necessary (the CLI's attach logic).
 * `autospawn` defaults to true; pass false for commands that must not start it.
 */
export async function connectDaemon(opts: {
  config: Config;
  autospawn?: boolean;
}): Promise<DaemonConnection> {
  const existing = await readLiveRuntime();
  if (existing) return clientFor(existing);

  if (opts.autospawn === false) {
    throw new LlamactlError("daemon_unreachable", "daemon is not running");
  }

  // Fork a detached daemon and wait once for it to publish runtime.json.
  spawnDaemon();
  const rt = await awaitRuntime(5000);
  if (!rt) {
    throw new LlamactlError(
      "daemon_unreachable",
      "started the daemon but it did not become ready within 5s; check logs",
    );
  }
  return clientFor(rt);
}

/** Read a live runtime without spawning (used by `daemon stop`). */
export async function currentRuntime(): Promise<Runtime | null> {
  return readLiveRuntime();
}

export { isProcessAlive };
