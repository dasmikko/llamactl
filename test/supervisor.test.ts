import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Config, Model, ModelResolver } from "../src/types.ts";
import { LlamactlError, isLlamactlError } from "../src/errors.ts";
import { Supervisor, type SupervisorOptions } from "../src/supervisor/process.ts";

const FAKE_SERVER = resolve(import.meta.dir, "helpers/fake-llama-server.ts");

const FAKE_ENV_KEYS = [
  "FAKE_READY_DELAY_MS",
  "FAKE_CRASH_AFTER_MS",
  "FAKE_FAIL_START",
  "FAKE_MODEL",
] as const;

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    path: "/dummy/path/model.gguf",
    sizeBytes: 1234,
    quant: "Q4_K_M",
    source: "config",
    mtimeMs: 0,
    arch: null,
    contextLength: null,
    nLayers: null,
    kvDim: null,
    nEmbd: null,
    nHeads: null,
    kind: "text",
    org: null,
    repo: null,
    ...overrides,
  };
}

/** A stub resolver that returns a fixed Model for any selector matching its id. */
function makeResolver(model: Model): ModelResolver {
  return {
    resolve(selector: string): Model {
      if (selector === model.id || selector === model.name) return model;
      throw new LlamactlError("model_not_found", `no model for "${selector}"`);
    },
    all: () => [model],
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    modelPaths: [],
    controlPort: 48134,
    llamaServerPath: null,
    activeInstall: null,
    defaultCtx: 2048,
    defaultGpuLayers: 99,
    llamaServerArgs: [],
    downloadDir: "/tmp/llamactl-test-dl",
    hfToken: null,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns true or the timeout elapses. */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(stepMs);
  }
  return false;
}

let logsDir: string;
let supervisors: Supervisor[] = [];

function newSupervisor(opts: Partial<SupervisorOptions> = {}): Supervisor {
  const model = opts.resolver ? undefined : makeModel();
  const sup = new Supervisor({
    config: opts.config ?? makeConfig(),
    resolver: opts.resolver ?? makeResolver(model!),
    logsDir,
    llamaServerPath: FAKE_SERVER,
    spawnPrefix: [process.execPath],
    portBase: 18500,
    ...opts,
  });
  supervisors.push(sup);
  return sup;
}

beforeEach(async () => {
  logsDir = await mkdtemp(join(tmpdir(), "llamactl-sup-"));
});

afterEach(async () => {
  for (const s of supervisors) {
    try {
      await s.shutdownAll();
    } catch {
      /* ignore */
    }
  }
  supervisors = [];
  for (const k of FAKE_ENV_KEYS) delete process.env[k];
  await rm(logsDir, { recursive: true, force: true });
});

describe("Supervisor", () => {
  test("ready path: ensureReady reaches status ready and /health is 200", async () => {
    const sup = newSupervisor();
    const rm0 = await sup.ensureReady({ model: "test-model" });
    expect(rm0.status).toBe("ready");

    const res = await fetch(`http://127.0.0.1:${rm0.port}/health`);
    expect(res.status).toBe(200);
    await res.json();

    expect(sup.get("test-model")?.status).toBe("ready");
  }, 15000);

  test("llamaServerVersion: detected from `--version` and stamped on the running model", async () => {
    const sup = newSupervisor();
    const rm0 = await sup.start({ model: "test-model" });
    expect(rm0.llamaServerVersion).toBe("9999 (fake-llama)");
    expect(sup.get("test-model")?.llamaServerVersion).toBe("9999 (fake-llama)");
  }, 15000);

  test("serverInfo: reports found + version for an existing binary", async () => {
    const sup = newSupervisor();
    const info = await sup.serverInfo();
    expect(info.found).toBe(true);
    expect(info.path).toBe(FAKE_SERVER);
    expect(info.version).toBe("9999 (fake-llama)");
  }, 15000);

  test("serverInfo: reports not-found for a missing binary path", async () => {
    const sup = newSupervisor({ llamaServerPath: "/no/such/llama-server" });
    const info = await sup.serverInfo();
    expect(info.found).toBe(false);
    expect(info.path).toBe("/no/such/llama-server");
    expect(info.version).toBeUndefined();
  });

  test("start alone flips to ready in the background (no ensureReady call)", async () => {
    const sup = newSupervisor();
    const started = await sup.start({ model: "test-model" });
    expect(started.status).toBe("starting");

    // The supervisor's background probe must move it to ready on its own.
    const becameReady = await waitFor(() => sup.get("test-model")?.status === "ready", 8000);
    expect(becameReady).toBe(true);
  }, 15000);

  test("readiness delay: ensureReady waits for /health to flip", async () => {
    process.env.FAKE_READY_DELAY_MS = "400";
    const sup = newSupervisor({ readinessTimeoutMs: 10000 });

    const started = await sup.start({ model: "test-model" });
    expect(started.status).toBe("starting");

    const ready = await sup.ensureReady({ model: "test-model" });
    expect(ready.status).toBe("ready");
  }, 15000);

  test("already_running: second start of the same model throws", async () => {
    const sup = newSupervisor();
    await sup.start({ model: "test-model" });

    let err: unknown;
    try {
      await sup.start({ model: "test-model" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect((err as LlamactlError).code).toBe("already_running");
  }, 15000);

  test("stop: removes the child and frees the port; second stop throws not_running", async () => {
    const sup = newSupervisor();
    const ready = await sup.ensureReady({ model: "test-model" });
    const port = ready.port;

    const stopped = await sup.stop("test-model");
    expect(stopped.modelId).toBe("test-model");
    expect(sup.list().some((m) => m.modelId === "test-model")).toBe(false);

    // The port should stop accepting connections once the child is gone.
    const portClosed = await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    expect(portClosed).toBe(true);

    let err: unknown;
    try {
      await sup.stop("test-model");
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect((err as LlamactlError).code).toBe("not_running");
  }, 15000);

  test("launch fail: ensureReady rejects with a LlamactlError and leaves nothing running", async () => {
    process.env.FAKE_FAIL_START = "1";
    const sup = newSupervisor({
      retryCap: 1,
      retryWindowMs: 60000,
      readinessTimeoutMs: 8000,
    });

    let err: unknown;
    try {
      await sup.ensureReady({ model: "test-model" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    const code = (err as LlamactlError).code;
    expect(["launch_failed", "restart_cap_exceeded"]).toContain(code);

    // No healthy/ready child should be left behind.
    const left = sup.get("test-model");
    if (left) {
      expect(left.status).not.toBe("ready");
    }
  }, 20000);

  test("crash + cap: restarts stop at the cap and the entry ends crashed", async () => {
    process.env.FAKE_CRASH_AFTER_MS = "150";
    const sup = newSupervisor({
      retryCap: 2,
      retryWindowMs: 120000,
      readinessTimeoutMs: 8000,
    });

    await sup.start({ model: "test-model" });

    // Poll until it settles into "crashed" (cap exceeded). Restarts must never
    // grow beyond the cap.
    let maxRestarts = 0;
    const crashed = await waitFor(() => {
      const m = sup.get("test-model");
      if (m) maxRestarts = Math.max(maxRestarts, m.restarts);
      return m?.status === "crashed";
    }, 6000);

    expect(crashed).toBe(true);
    expect(maxRestarts).toBeLessThanOrEqual(2);
    expect(sup.get("test-model")?.status).toBe("crashed");

    // Give a moment to confirm restarts truly stopped growing.
    const before = sup.get("test-model")?.restarts ?? 0;
    await delay(1000);
    const after = sup.get("test-model")?.restarts ?? 0;
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(2);
  }, 15000);

  test("crash + cap via ensureReady throws restart_cap_exceeded", async () => {
    // Crash before the server ever reports ready, so ensureReady can never
    // succeed and must surface the restart-cap failure instead.
    process.env.FAKE_CRASH_AFTER_MS = "150";
    process.env.FAKE_READY_DELAY_MS = "100000";
    const sup = newSupervisor({
      retryCap: 1,
      retryWindowMs: 120000,
      readinessTimeoutMs: 10000,
    });

    let err: unknown;
    try {
      await sup.ensureReady({ model: "test-model" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect(["restart_cap_exceeded", "launch_failed"]).toContain(
      (err as LlamactlError).code,
    );
  }, 15000);

  test("llama_server_missing: a non-existent binary path throws on start", async () => {
    const sup = newSupervisor({
      llamaServerPath: "/nonexistent/path/to/llama-server",
    });
    let err: unknown;
    try {
      await sup.start({ model: "test-model" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect((err as LlamactlError).code).toBe("llama_server_missing");
  }, 15000);

  test("model_not_found propagates from the resolver", async () => {
    const sup = newSupervisor();
    let err: unknown;
    try {
      await sup.start({ model: "does-not-exist" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect((err as LlamactlError).code).toBe("model_not_found");
  }, 15000);
});
