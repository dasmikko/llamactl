/**
 * Runtime-state helpers for the daemon: write/read `runtime.json` (the file the
 * CLI uses to find and authenticate to the daemon), detect stale state via PID
 * liveness, generate bearer tokens, and compare tokens in constant time.
 */

import { mkdir, writeFile, readFile, chmod, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

import type { Runtime } from "../types.ts";
import { runtimePath, stateDir } from "../config/paths.ts";

/** Generate a bearer token: 32 random bytes as lowercase hex (64 chars). */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Persist the runtime to `runtime.json` with mode 0600. Ensures the state dir
 * exists first. Never logs the token.
 */
export async function writeRuntime(rt: Runtime): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  const path = runtimePath();
  const json = JSON.stringify(rt, null, 2);
  await writeFile(path, json, { mode: 0o600 });
  if (process.platform !== "win32") {
    // Explicit chmod: writeFile's mode is masked by umask, so force 0600.
    await chmod(path, 0o600);
  }
}

/** Read and parse `runtime.json`, or null if absent or malformed. */
export async function readRuntime(): Promise<Runtime | null> {
  let raw: string;
  try {
    raw = await readFile(runtimePath(), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as Runtime;
  } catch {
    return null;
  }
}

/**
 * True if a process with `pid` exists. `process.kill(pid, 0)` sends no signal
 * but performs the existence/permission check: ESRCH means no such process,
 * EPERM means it exists but isn't ours (still alive).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Read the runtime, returning it only if the recorded daemon PID is still
 * alive. A present file with a dead PID is stale → null.
 */
export async function readLiveRuntime(): Promise<Runtime | null> {
  const rt = await readRuntime();
  if (rt === null) return null;
  if (!isProcessAlive(rt.pid)) return null;
  return rt;
}

/** Remove `runtime.json` if present; ignore "not found". */
export async function clearRuntime(): Promise<void> {
  try {
    await unlink(runtimePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Constant-time string comparison. Different lengths return false but still run
 * a dummy compare so timing does not leak the length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
