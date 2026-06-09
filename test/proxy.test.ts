/**
 * Tests for the OpenAI-compatible reverse proxy.
 *
 * These exercise the proxy over REAL HTTP against in-process fake upstreams,
 * using a mock ISupervisor (no real supervisor / child processes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startProxy, type ProxyHandle } from "../src/proxy/proxy.ts";
import { startFakeServer, type FakeServer } from "./helpers/fake-llama-server.ts";
import { defaultConfig } from "../src/config/config.ts";
import { BunstashError } from "../src/errors.ts";
import type { ApiError, ISupervisor, Model, RunningModel } from "../src/types.ts";

let modelAServer: FakeServer;
let modelBServer: FakeServer;

/** Build a ready RunningModel pointing at the given upstream port. */
function running(modelId: string, port: number): RunningModel {
  return {
    modelId,
    name: modelId,
    path: `/fake/${modelId}.gguf`,
    pid: 1234,
    port,
    status: "ready",
    startedAt: Date.now(),
    restarts: 0,
    logPath: `/fake/${modelId}.log`,
  };
}

/** Build a Model literal for GET /v1/models. */
function modelLiteral(id: string): Model {
  return {
    id,
    name: id,
    path: `/fake/${id}.gguf`,
    sizeBytes: 1024,
    quant: "Q4_K_M",
    source: "config",
    mtimeMs: Date.now(),
  };
}

let handleFallbackOn: ProxyHandle;
let handleFallbackOff: ProxyHandle;

/** Build a mock supervisor whose ensureReady maps known ids and throws on "boom". */
function makeSupervisor(): ISupervisor {
  return {
    list(): RunningModel[] {
      // Only modelB is a *ready* peer available for fallback; modelA is shown
      // as still starting so the fallback target is deterministic (modelB).
      const a = running("modelA", modelAServer.port);
      a.status = "starting";
      return [a, running("modelB", modelBServer.port)];
    },
    get(modelId: string): RunningModel | undefined {
      return this.list().find((r) => r.modelId === modelId);
    },
    async start(): Promise<RunningModel> {
      throw new BunstashError("internal", "not used in tests");
    },
    async stop(): Promise<RunningModel> {
      throw new BunstashError("not_running", "not used in tests");
    },
    async ensureReady(selector: string): Promise<RunningModel> {
      if (selector === "modelA") return running("modelA", modelAServer.port);
      if (selector === "modelB") return running("modelB", modelBServer.port);
      throw new BunstashError("launch_failed", `cannot launch '${selector}'`);
    },
    async shutdownAll(): Promise<void> {
      /* no-op */
    },
  };
}

const models = () => [modelLiteral("modelA"), modelLiteral("modelB")];

beforeAll(() => {
  modelAServer = startFakeServer({ model: "modelA" });
  modelBServer = startFakeServer({ model: "modelB" });

  const supervisor = makeSupervisor();

  const cfgOn = { ...defaultConfig(), fallbackEnabled: true };
  cfgOn.proxy = { host: "127.0.0.1", port: 0 };
  handleFallbackOn = startProxy({ config: cfgOn, supervisor, models });

  const cfgOff = { ...defaultConfig(), fallbackEnabled: false };
  cfgOff.proxy = { host: "127.0.0.1", port: 0 };
  handleFallbackOff = startProxy({ config: cfgOff, supervisor, models });
});

afterAll(() => {
  handleFallbackOn.stop();
  handleFallbackOff.stop();
  modelAServer.stop();
  modelBServer.stop();
});

describe("proxy basic routes", () => {
  test("GET / reports running", async () => {
    const res = await fetch(handleFallbackOn.url + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bunstash is running");
  });

  test("GET /health is ok", async () => {
    const res = await fetch(handleFallbackOn.url + "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /v1/models lists both model ids", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: { id: string; object: string; owned_by: string }[];
    };
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("modelA");
    expect(ids).toContain("modelB");
    expect(body.data[0]!.owned_by).toBe("bunstash");
  });

  test("unknown route is 404 not_found", async () => {
    const res = await fetch(handleFallbackOn.url + "/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("not_found");
  });
});

describe("proxy forwarding", () => {
  test("POST /v1/chat/completions (non-stream) forwards to modelA", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "modelA", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bunstash-served-by")).toBe("modelA");
    const text = await res.text();
    expect(text).toContain("hello world");
  });

  test("POST /v1/chat/completions (stream) passes SSE through", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "modelA", stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-bunstash-served-by")).toBe("modelA");

    // Read the streamed body and assert it contains the chunks + DONE sentinel.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    acc += decoder.decode();
    expect(acc).toContain("hello");
    expect(acc).toContain("[DONE]");
  });

  test("POST /v1/embeddings returns an embedding array", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "modelA", input: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bunstash-served-by")).toBe("modelA");
    const body = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    expect(Array.isArray(body.data[0]!.embedding)).toBe(true);
    expect(body.data[0]!.embedding.length).toBeGreaterThan(0);
  });

  test("missing model is 400 bad_request", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("bad_request");
  });
});

describe("proxy fallback", () => {
  test("fallback enabled: 'boom' is served by a ready peer (modelB)", async () => {
    const res = await fetch(handleFallbackOn.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "boom", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bunstash-served-by")).toBe("modelB");
    const reason = res.headers.get("x-bunstash-fallback-reason");
    expect(reason).toBeTruthy();
    expect(reason).toContain("launch_failed");
    expect(await res.text()).toContain("hello world");
  });

  test("fallback disabled: 'boom' hard-fails with launch_failed", async () => {
    const res = await fetch(handleFallbackOff.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "boom", messages: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("launch_failed");
  });
});
