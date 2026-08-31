import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Config, Model, ModelResolver } from "../src/types.ts";
import { LlamactlError, isLlamactlError } from "../src/errors.ts";
import { Supervisor, parseLogWarnings, type SupervisorOptions } from "../src/supervisor/process.ts";

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
    nextnLayers: null,
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


describe("MTP draft-model auto-resolution", () => {
  /** A resolver holding a base model plus its sibling MTP head. */
  function mtpResolver(): { resolver: ModelResolver; headPath: string } {
    const base = makeModel({
      id: "qwen",
      name: "Qwen",
      path: "/hf/models--u--Q-GGUF/snapshots/a/Q-Q4_K_M.gguf",
      sizeBytes: 16_000_000_000,
      quant: "Q4_K_M",
      repo: "u/Q-GGUF",
    });
    const head = makeModel({
      id: "mtp-qwen",
      name: "mtp-Qwen",
      path: "/hf/models--u--Q-GGUF/snapshots/a/MTP/mtp-Q-Q4_0.gguf",
      sizeBytes: 500_000_000, // a real head is a small fraction of the model
      quant: "Q4_0",
      repo: "u/Q-GGUF",
      kind: "mtp",
      nextnLayers: 1,
    });
    return {
      headPath: head.path,
      resolver: {
        resolve(sel: string): Model {
          if (sel === base.id || sel === base.name) return base;
          if (sel === head.id) return head;
          throw new LlamactlError("model_not_found", `no model for "${sel}"`);
        },
        all: () => [base, head],
      },
    };
  }

  test("fills --spec-draft-model when spec-type asks for draft-mtp", async () => {
    const { resolver, headPath } = mtpResolver();
    const sup = newSupervisor({ resolver });
    const running = await sup.start({
      model: "qwen",
      extraFlags: { "--spec-type": "draft-mtp" },
    });
    expect(running.spec.specDraftModel).toBe(headPath);
  });

  test("leaves an explicit draft model alone", async () => {
    const { resolver } = mtpResolver();
    const sup = newSupervisor({ resolver });
    const running = await sup.start({
      model: "qwen",
      specDraftModel: "/my/own/head.gguf",
      extraFlags: { "--spec-type": "draft-mtp" },
    });
    expect(running.spec.specDraftModel).toBe("/my/own/head.gguf");
  });

  test("does nothing when draft-mtp wasn't requested", async () => {
    const { resolver } = mtpResolver();
    const sup = newSupervisor({ resolver });
    const running = await sup.start({ model: "qwen" });
    expect(running.spec.specDraftModel).toBeUndefined();
  });

  test("never makes a model its own draft model", async () => {
    // The failure this guards against is a CUDA OOM: llama.cpp loads the draft
    // model in full, so pointing a 16 GB quant at itself needs 32 GB of VRAM.
    const base = makeModel({
      id: "qwen",
      name: "Qwen",
      path: "/hf/snap/Q-Q4_K_M.gguf",
      quant: "Q4_K_M",
      repo: "u/Q-GGUF",
      kind: "mtp", // even if misclassified upstream
      nextnLayers: 1,
    });
    const sup = newSupervisor({
      resolver: {
        resolve: (sel: string): Model => {
          if (sel === base.id || sel === base.name) return base;
          throw new LlamactlError("model_not_found", `no model for "${sel}"`);
        },
        all: () => [base],
      },
    });
    const running = await sup.start({
      model: "qwen",
      extraFlags: { "--spec-type": "draft-mtp" },
    });
    expect(running.spec.specDraftModel).toBeUndefined();
  });

  test("recognises draft-mtp inside a comma-separated spec-type list", async () => {
    const { resolver, headPath } = mtpResolver();
    const sup = newSupervisor({ resolver });
    const running = await sup.start({
      model: "qwen",
      extraFlags: { "--spec-type": "ngram-simple,draft-mtp" },
    });
    expect(running.spec.specDraftModel).toBe(headPath);
  });
});

describe("parseLogWarnings", () => {
  test("lifts llama.cpp's timestamped W/E lines", () => {
    const log = [
      "0.00.014.109 I log_info: verbosity = 3",
      "0.00.315.587 W srv    load_model: [spec] failed to measure MTP context memory",
      "0.00.974.533 E srv    load_model: failed to create MTP context",
      "0.00.704.453 I slot   load_model: id  0 | new slot",
    ].join("\n");
    expect(parseLogWarnings(log)).toEqual([
      "warning: srv    load_model: [spec] failed to measure MTP context memory",
      "error: srv    load_model: failed to create MTP context",
    ]);
  });

  test("catches the bare pre-logger warnings too", () => {
    const log = [
      "warning: no usable GPU found, --gpu-layers option will be ignored",
      "warning: one possible reason is that llama.cpp was compiled without GPU support",
      "0.00.014.109 I log_info: verbosity = 3",
    ].join("\n");
    expect(parseLogWarnings(log)).toEqual([
      "warning: no usable GPU found, --gpu-layers option will be ignored",
      "warning: one possible reason is that llama.cpp was compiled without GPU support",
    ]);
  });

  test("dedupes repeats and returns none for a clean log", () => {
    const dup = "0.00.1 W a: b\n0.00.2 W a: b\n";
    expect(parseLogWarnings(dup)).toEqual(["warning: a: b"]);
    expect(parseLogWarnings("0.00.1 I all good\n")).toEqual([]);
    expect(parseLogWarnings("")).toEqual([]);
  });

  test("caps a flood of warnings", () => {
    const many = Array.from({ length: 50 }, (_, i) => `0.00.${i} W line ${i}`).join("\n");
    expect(parseLogWarnings(many).length).toBeLessThanOrEqual(12);
  });
});
