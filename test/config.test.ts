import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PORT_DEFAULT,
  PROXY_PORT_DEFAULT,
  PROXY_PORT_OLLAMA,
  configFromEnv,
  defaultConfig,
  mergeConfig,
  resolveConfig,
} from "../src/config/config.ts";

describe("defaultConfig", () => {
  test("has loopback proxy + standard ports + safe defaults", () => {
    const c = defaultConfig();
    expect(c.proxy.host).toBe("127.0.0.1");
    expect(c.proxy.port).toBe(PROXY_PORT_DEFAULT);
    expect(c.controlPort).toBe(CONTROL_PORT_DEFAULT);
    expect(c.fallbackEnabled).toBe(false);
    expect(c.ollamaCompat).toBe(false);
    expect(c.llamaServerPath).toBeNull();
  });
});

describe("mergeConfig", () => {
  test("overrides win and are deep-merged for proxy", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, { proxy: { port: 9999 }, fallbackEnabled: true });
    expect(merged.proxy.port).toBe(9999);
    expect(merged.proxy.host).toBe("127.0.0.1"); // untouched
    expect(merged.fallbackEnabled).toBe(true);
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
  test("parses BUNSTASH_* vars with correct types", () => {
    const p = configFromEnv({
      BUNSTASH_MODEL_PATHS: "/a:/b",
      BUNSTASH_CONTROL_PORT: "50000",
      BUNSTASH_PROXY_PORT: "12000",
      BUNSTASH_CTX: "16384",
      BUNSTASH_FALLBACK: "1",
      BUNSTASH_OLLAMA_COMPAT: "true",
    });
    expect(p.modelPaths).toEqual(["/a", "/b"]);
    expect(p.controlPort).toBe(50000);
    expect(p.proxy?.port).toBe(12000);
    expect(p.defaultCtx).toBe(16384);
    expect(p.fallbackEnabled).toBe(true);
    expect(p.ollamaCompat).toBe(true);
  });

  test("ignores absent vars and bad numbers", () => {
    const p = configFromEnv({ BUNSTASH_CONTROL_PORT: "not-a-number" });
    expect(p.controlPort).toBeUndefined();
    expect(Object.keys(p)).toHaveLength(0);
  });
});

describe("resolveConfig precedence: defaults -> file -> env -> flags", () => {
  let dir: string;
  let cfgFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bunstash-cfg-"));
    cfgFile = join(dir, "config.json");
    await writeFile(
      cfgFile,
      JSON.stringify({ defaultCtx: 2048, proxy: { port: 5000 }, fallbackEnabled: true }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("file overrides defaults", async () => {
    const c = await resolveConfig({ configFile: cfgFile, env: {} });
    expect(c.defaultCtx).toBe(2048);
    expect(c.proxy.port).toBe(5000);
    expect(c.fallbackEnabled).toBe(true);
  });

  test("env overrides file", async () => {
    const c = await resolveConfig({
      configFile: cfgFile,
      env: { BUNSTASH_CTX: "3333" },
    });
    expect(c.defaultCtx).toBe(3333); // env beats file
    expect(c.proxy.port).toBe(5000); // file still applies where env is silent
  });

  test("flags override env and file", async () => {
    const c = await resolveConfig({
      configFile: cfgFile,
      env: { BUNSTASH_CTX: "3333" },
      flags: { defaultCtx: 4444, proxy: { host: "0.0.0.0" } },
    });
    expect(c.defaultCtx).toBe(4444);
    expect(c.proxy.host).toBe("0.0.0.0");
  });

  test("ollama-compat defaults proxy port to 11434 when unset elsewhere", async () => {
    const c = await resolveConfig({
      configFile: join(dir, "does-not-exist.json"),
      env: { BUNSTASH_OLLAMA_COMPAT: "1" },
    });
    expect(c.ollamaCompat).toBe(true);
    expect(c.proxy.port).toBe(PROXY_PORT_OLLAMA);
  });

  test("explicit proxy port wins over ollama-compat default", async () => {
    const c = await resolveConfig({
      configFile: join(dir, "does-not-exist.json"),
      env: { BUNSTASH_OLLAMA_COMPAT: "1" },
      flags: { proxy: { port: 7777 } },
    });
    expect(c.proxy.port).toBe(7777);
  });
});
