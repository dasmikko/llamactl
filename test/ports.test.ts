import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server, type AddressInfo } from "node:net";

import { isPortFree, findFreePort } from "../src/net/ports.ts";

const HOST = "127.0.0.1";
const servers: Server[] = [];

/** Listen on `port` (0 = OS-assigned) and resolve the actual bound port. */
function occupy(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    servers.push(srv);
    srv.once("error", reject);
    srv.listen(port, HOST, () => {
      const addr = srv.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => srv.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(servers.map(closeServer));
  servers.length = 0;
});

describe("isPortFree", () => {
  test("false for an occupied port, true once released", async () => {
    const port = await occupy(0);
    expect(await isPortFree(port, HOST)).toBe(false);

    const srv = servers.pop()!;
    await closeServer(srv);
    expect(await isPortFree(port, HOST)).toBe(true);
  });
});

describe("findFreePort", () => {
  test("returns a free port >= start", async () => {
    // Use a known-free port as the start so the result should equal start.
    const start = await findFreePort(49200, HOST);
    const found = await findFreePort(start, HOST);
    expect(found).toBeGreaterThanOrEqual(start);
    expect(await isPortFree(found, HOST)).toBe(true);
  });

  test("skips an occupied start port", async () => {
    // Find a free port, occupy it, then ask findFreePort to start there.
    const start = await findFreePort(49300, HOST);
    const occupied = await occupy(start);
    expect(occupied).toBe(start);
    expect(await isPortFree(start, HOST)).toBe(false);

    const found = await findFreePort(start, HOST);
    expect(found).toBeGreaterThan(start);
  });
});
