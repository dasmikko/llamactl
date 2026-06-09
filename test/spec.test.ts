import { describe, test, expect } from "bun:test";
import type { Config, LaunchSpec } from "../src/types.ts";
import { LlamactlError, isLlamactlError } from "../src/errors.ts";
import { applyDefaults, specToArgs, validateSpec } from "../src/instances/spec.ts";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    modelPaths: [],
    controlPort: 48134,
    llamaServerPath: null,
    defaultCtx: 4096,
    defaultGpuLayers: 99,
    llamaServerArgs: [],
    ...overrides,
  };
}

describe("applyDefaults", () => {
  test("fills ctxSize, gpuLayers, and host from config defaults", () => {
    const out = applyDefaults({ model: "m" }, cfg({ defaultCtx: 2048, defaultGpuLayers: 99 }));
    expect(out.ctxSize).toBe(2048);
    expect(out.gpuLayers).toBe(99); // GPU by default
    expect(out.host).toBe("127.0.0.1");
  });
  test("does not overwrite explicit fields", () => {
    const out = applyDefaults({ model: "m", ctxSize: 99, gpuLayers: 10, host: "0.0.0.0" }, cfg());
    expect(out.ctxSize).toBe(99);
    expect(out.gpuLayers).toBe(10);
    expect(out.host).toBe("0.0.0.0");
  });
  test("preserves an explicit gpuLayers: 0 (CPU-only)", () => {
    const out = applyDefaults({ model: "m", gpuLayers: 0 }, cfg({ defaultGpuLayers: 99 }));
    expect(out.gpuLayers).toBe(0);
  });
});

describe("specToArgs", () => {
  test("ctx-only spec matches the legacy inline argv", () => {
    const spec: LaunchSpec = { model: "m", ctxSize: 4096, host: "127.0.0.1" };
    const args = specToArgs({ modelPath: "/x.gguf", port: 18000, spec, configArgs: [] });
    expect(args).toEqual([
      "-m", "/x.gguf",
      "--host", "127.0.0.1",
      "--port", "18000",
      "--ctx-size", "4096",
    ]);
  });

  test("emits each structured flag only when defined, in stable order", () => {
    const spec: LaunchSpec = {
      model: "m",
      ctxSize: 8192,
      gpuLayers: 33,
      threads: 8,
      batchSize: 512,
      flashAttn: "on",
      host: "127.0.0.1",
    };
    const args = specToArgs({ modelPath: "/x.gguf", port: 18001, spec, configArgs: ["--verbose"] });
    expect(args).toEqual([
      "-m", "/x.gguf",
      "--host", "127.0.0.1",
      "--port", "18001",
      "--ctx-size", "8192",
      "--gpu-layers", "33",
      "--threads", "8",
      "--batch-size", "512",
      "--flash-attn", "on",
      "--verbose",
    ]);
  });

  test("flashAttn off emits '--flash-attn off'; undefined (auto) emits nothing", () => {
    const off = specToArgs({ modelPath: "/x.gguf", port: 1, spec: { model: "m", flashAttn: "off" }, configArgs: [] });
    expect(off[off.indexOf("--flash-attn") + 1]).toBe("off");
    const auto = specToArgs({ modelPath: "/x.gguf", port: 1, spec: { model: "m" }, configArgs: [] });
    expect(auto).not.toContain("--flash-attn");
  });

  test("emits reasoning, jinja, and chat-template flags", () => {
    const on = specToArgs({
      modelPath: "/x.gguf", port: 1, configArgs: [],
      spec: { model: "m", reasoning: "on", jinja: "on", chatTemplate: "chatml" },
    });
    expect(on[on.indexOf("--reasoning") + 1]).toBe("on");
    expect(on).toContain("--jinja");
    expect(on[on.indexOf("--chat-template") + 1]).toBe("chatml");

    const off = specToArgs({
      modelPath: "/x.gguf", port: 1, configArgs: [],
      spec: { model: "m", reasoning: "off", jinja: "off" },
    });
    expect(off[off.indexOf("--reasoning") + 1]).toBe("off");
    expect(off).toContain("--no-jinja");

    const auto = specToArgs({ modelPath: "/x.gguf", port: 1, spec: { model: "m" }, configArgs: [] });
    expect(auto).not.toContain("--reasoning");
    expect(auto).not.toContain("--jinja");
    expect(auto).not.toContain("--no-jinja");
    expect(auto).not.toContain("--chat-template");
  });

  test("emits --cache-type-k/-v when set", () => {
    const spec: LaunchSpec = { model: "m", cacheTypeK: "q8_0", cacheTypeV: "q4_0" };
    const args = specToArgs({ modelPath: "/x.gguf", port: 1, spec, configArgs: [] });
    expect(args).toContain("--cache-type-k");
    expect(args[args.indexOf("--cache-type-k") + 1]).toBe("q8_0");
    expect(args[args.indexOf("--cache-type-v") + 1]).toBe("q4_0");
  });

  test("extraArgs precede configArgs", () => {
    const spec: LaunchSpec = { model: "m", extraArgs: ["--mlock"] };
    const args = specToArgs({ modelPath: "/x.gguf", port: 18002, spec, configArgs: ["--foo"] });
    expect(args).not.toContain("--flash-attn");
    expect(args.indexOf("--mlock")).toBeLessThan(args.indexOf("--foo"));
  });
});

describe("validateSpec", () => {
  test("rejects empty model", () => {
    let err: unknown;
    try {
      validateSpec({ model: "" });
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect((err as LlamactlError).code).toBe("invalid_spec");
  });
  test("rejects negative ctxSize and out-of-range port", () => {
    expect(() => validateSpec({ model: "m", ctxSize: -1 })).toThrow();
    expect(() => validateSpec({ model: "m", port: 70000 })).toThrow();
  });
  test("accepts a sane spec", () => {
    expect(() => validateSpec({ model: "m", ctxSize: 4096, gpuLayers: 0, port: 8080 })).not.toThrow();
  });
  test("rejects an unknown cache type, accepts a valid one", () => {
    expect(() => validateSpec({ model: "m", cacheTypeK: "bogus" })).toThrow();
    expect(() => validateSpec({ model: "m", cacheTypeK: "q8_0", cacheTypeV: "f16" })).not.toThrow();
  });
});
