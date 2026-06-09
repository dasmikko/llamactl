import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ISupervisor, Model, RunningModel } from "../src/types.ts";
import { BunstashError } from "../src/errors.ts";
import { startControlPlane, type ControlPlaneHandle } from "../src/daemon/controlplane.ts";
import { findFreePort, isPortFree } from "../src/net/ports.ts";
import { createServer, type Server } from "node:net";

const TOKEN = "a".repeat(64);

function model(id: string): Model {
  return { id, name: id, path: `/models/${id}.gguf`, sizeBytes: 1, quant: null, source: "config", mtimeMs: 0 };
}
function running(id: string): RunningModel {
  return {
    modelId: id, name: id, path: `/models/${id}.gguf`, pid: 1234, port: 18000,
    status: "ready", startedAt: 0, restarts: 0, logPath: "/tmp/x.log",
  };
}

/** Minimal mock supervisor that records calls. */
function mockSupervisor(): ISupervisor & { started: string[]; stopped: string[] } {
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    list: () => [running("alpha")],
    get: () => undefined,
    start: async (sel) => {
      started.push(sel);
      if (sel === "ghost") throw new BunstashError("model_not_found", "no such model: ghost");
      return running(sel);
    },
    stop: async (sel) => {
      stopped.push(sel);
      if (sel === "idle") throw new BunstashError("not_running", "not running: idle");
      return running(sel);
    },
    ensureReady: async (sel) => running(sel),
    shutdownAll: async () => {},
  };
}

let handle: ControlPlaneHandle;
let sup: ReturnType<typeof mockSupervisor>;
const base = () => handle.url;

beforeAll(async () => {
  sup = mockSupervisor();
  handle = await startControlPlane({
    token: TOKEN,
    supervisor: sup,
    models: () => [model("alpha"), model("beta")],
    startPort: await findFreePort(49200),
    pid: process.pid,
    startedAt: Date.now(),
    onShutdown: () => {},
  });
});
afterAll(() => handle.stop());

test("GET /health requires no auth", async () => {
  const res = await fetch(base() + "/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pid: number };
  expect(body.ok).toBe(true);
  expect(body.pid).toBe(process.pid);
});

test("protected routes reject a missing token", async () => {
  const res = await fetch(base() + "/ps");
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("unauthorized");
});

test("protected routes reject a wrong token (same length)", async () => {
  const res = await fetch(base() + "/ps", { headers: { authorization: `Bearer ${"b".repeat(64)}` } });
  expect(res.status).toBe(401);
});

test("GET /ps with the right token returns running models", async () => {
  const res = await fetch(base() + "/ps", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { running: RunningModel[] };
  expect(body.running[0]?.modelId).toBe("alpha");
});

test("GET /models returns discovered models", async () => {
  const res = await fetch(base() + "/models", { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = (await res.json()) as { models: Model[] };
  expect(body.models.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
});

test("POST /start forwards the selector to the supervisor", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "alpha" }),
  });
  expect(res.status).toBe(200);
  expect(sup.started).toContain("alpha");
});

test("POST /start with no model => 400 bad_request", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("supervisor's typed error surfaces with its status code", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ghost" }),
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("model_not_found");
});

test("unknown route => 404 not_found", async () => {
  const res = await fetch(base() + "/nope", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(404);
});

test("control plane scans upward when its preferred port is taken", async () => {
  const taken = await findFreePort(49300);
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(taken, "127.0.0.1", () => resolve()));
  try {
    const h = await startControlPlane({
      token: TOKEN,
      supervisor: mockSupervisor(),
      models: () => [],
      startPort: taken,
      pid: process.pid,
      startedAt: Date.now(),
      onShutdown: () => {},
    });
    expect(h.port).toBeGreaterThan(taken);
    expect(await isPortFree(taken)).toBe(false); // blocker still holds it
    h.stop();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
