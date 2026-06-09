import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PORT_DEFAULT,
  configFromEnv,
  defaultConfig,
  mergeConfig,
  resolveConfig,
} from "../src/config/config.ts";

describe("defaultConfig", () => {
  test("has standard control port and safe defaults", () => {
    const c = defaultConfig();
    expect(c.controlPort).toBe(CONTROL_PORT_DEFAULT);
    expect(c.defaultCtx).toBe(4096);
    expect(c.defaultGpuLayers).toBe(99); // offload to GPU by default
    expect(c.modelPaths).toEqual([]);
    expect(c.llamaServerArgs).toEqual([]);
    expect(c.llamaServerPath).toBeNull();
  });
});

describe("mergeConfig", () => {
  test("overrides win over the base layer", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, { controlPort: 9999, defaultCtx: 8192 });
    expect(merged.controlPort).toBe(9999);
    expect(merged.defaultCtx).toBe(8192);
  });

  test("absent override keys leave base untouched", () => {
    const base = mergeConfig(defaultConfig(), { defaultCtx: 8192 });
    const merged = mergeConfig(base, {});
    expect(merged.defaultCtx).toBe(8192);
  });

  test("llamaServerPath can be explicitly set (not treated as absent)", () => {
    const merged = mergeConfig(defaultConfig(), { llamaServerPath: "/opt/llama-server" });
    expect(merged.llamaServerPath).toBe("/opt/llama-server");
  });
});

describe("configFromEnv", () => {
  test("parses LLAMACTL_* vars with correct types", () => {
    const p = configFromEnv({
      LLAMACTL_MODEL_PATHS: "/a:/b",
      LLAMACTL_CONTROL_PORT: "50000",
      LLAMACTL_CTX: "16384",
      LLAMACTL_GPU_LAYERS: "20",
      LLAMACTL_LLAMA_SERVER: "/usr/bin/llama-server",
    });
    expect(p.modelPaths).toEqual(["/a", "/b"]);
    expect(p.controlPort).toBe(50000);
    expect(p.defaultCtx).toBe(16384);
    expect(p.defaultGpuLayers).toBe(20);
    expect(p.llamaServerPath).toBe("/usr/bin/llama-server");
  });

  test("ignores absent vars and bad numbers", () => {
    const p = configFromEnv({ LLAMACTL_CONTROL_PORT: "not-a-number" });
    expect(p.controlPort).toBeUndefined();
    expect(Object.keys(p)).toHaveLength(0);
  });
});

describe("resolveConfig precedence: defaults -> file -> env -> flags", () => {
  let dir: string;
  let cfgFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "llamactl-cfg-"));
    cfgFile = join(dir, "config.json");
    await writeFile(
      cfgFile,
      JSON.stringify({ defaultCtx: 2048, controlPort: 5000 }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("file overrides defaults", async () => {
    const c = await resolveConfig({ configFile: cfgFile, env: {} });
    expect(c.defaultCtx).toBe(2048);
    expect(c.controlPort).toBe(5000);
  });

  test("env overrides file", async () => {
    const c = await resolveConfig({
      configFile: cfgFile,
      env: { LLAMACTL_CTX: "3333" },
    });
    expect(c.defaultCtx).toBe(3333); // env beats file
    expect(c.controlPort).toBe(5000); // file still applies where env is silent
  });

  test("flags override env and file", async () => {
    const c = await resolveConfig({
      configFile: cfgFile,
      env: { LLAMACTL_CTX: "3333" },
      flags: { defaultCtx: 4444, controlPort: 6000 },
    });
    expect(c.defaultCtx).toBe(4444);
    expect(c.controlPort).toBe(6000);
  });
});
