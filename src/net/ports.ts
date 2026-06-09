/**
 * Port helpers used by the control plane (scan upward from 48134) and the
 * supervisor (assign a free loopback port to each llama-server child). Uses
 * node:net so it works identically under `bun run` and the compiled binary.
 */

import { createServer } from "node:net";

/** Resolve true if `port` can be bound on `host`, false otherwise. */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Find the first free port at or above `start`, scanning upward up to `tries`
 * candidates. Throws if none is free in the window.
 */
export async function findFreePort(start: number, host = "127.0.0.1", tries = 64): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`no free port found in range ${start}..${start + tries - 1} on ${host}`);
}
