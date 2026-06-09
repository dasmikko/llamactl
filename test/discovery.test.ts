import { afterAll, describe, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverModels, parseQuant } from "../src/discovery/models.ts";

let tmp = "";

async function setup(): Promise<string> {
  if (tmp) return tmp;
  tmp = await mkdtemp(join(tmpdir(), "llamactl-discovery-"));
  // A nested directory to exercise recursion.
  const nested = join(tmp, "vendor", "models");
  await mkdir(nested, { recursive: true });

  const files = [
    join(tmp, "Llama-3.1-8B-Instruct-Q4_K_M.gguf"),
    join(tmp, "Mistral-7B-Instruct-Q8_0.gguf"),
    join(nested, "Phi-3-mini-F16.gguf"),
    // Sharded model: two physical files, one logical model.
    join(tmp, "foo-bar-Q6_K-00001-of-00002.gguf"),
    join(tmp, "foo-bar-Q6_K-00002-of-00002.gguf"),
    // A non-gguf file that must be ignored.
    join(tmp, "README.txt"),
  ];
  for (const f of files) {
    await writeFile(f, "");
  }
  return tmp;
}

afterAll(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
  }
});

describe("parseQuant", () => {
  test("parses and uppercases common quant tokens", () => {
    expect(parseQuant("Llama-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(parseQuant("model-q8_0")).toBe("Q8_0");
    expect(parseQuant("thing-iq3_xs-x")).toBe("IQ3_XS");
    expect(parseQuant("net-f16")).toBe("F16");
    expect(parseQuant("net-bf16")).toBe("BF16");
    expect(parseQuant("foo-mxfp4-bar")).toBe("MXFP4");
    expect(parseQuant("Q2_K-thing")).toBe("Q2_K");
  });

  test("returns null when no quant present", () => {
    expect(parseQuant("just-a-model")).toBeNull();
  });
});

describe("discoverModels", () => {
  test("discovers gguf files under extraPaths with source=config", async () => {
    const dir = await setup();
    const all = await discoverModels({ extraPaths: [dir] });
    // Scope to our temp dir — the machine may also have real models in the
    // default cache dirs, which discoverModels scans too.
    const models = all.filter((m) => m.path.startsWith(dir));

    // Sharded pair collapses to one => 4 logical models, not 5.
    expect(models.length).toBe(4);
    for (const m of models) {
      expect(m.source).toBe("config");
      expect(m.path.endsWith(".gguf")).toBe(true);
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.sizeBytes).toBe("number");
      expect(typeof m.mtimeMs).toBe("number");
    }
  });

  test("quant parsed and uppercased", async () => {
    const dir = await setup();
    const all = await discoverModels({ extraPaths: [dir] });
    const models = all.filter((m) => m.path.startsWith(dir));

    const llama = models.find((m) => m.id.includes("llama"));
    expect(llama).toBeDefined();
    expect(llama?.quant).toBe("Q4_K_M");

    const phi = models.find((m) => m.id.includes("phi"));
    expect(phi).toBeDefined();
    expect(phi?.quant).toBe("F16");
  });

  test("sharded model collapses to a single entry on the first shard", async () => {
    const dir = await setup();
    const models = (await discoverModels({ extraPaths: [dir] })).filter((m) =>
      m.path.startsWith(dir),
    );

    const shardModels = models.filter((m) => m.path.includes("foo-bar"));
    expect(shardModels.length).toBe(1);
    const shard = shardModels[0];
    expect(shard).toBeDefined();
    // Represented by the first shard's physical file.
    expect(shard?.path).toContain("00001-of-00002");
    // Shard suffix stripped from id/name.
    expect(shard?.id).not.toContain("00001");
    expect(shard?.id).not.toContain("of-00002");
    expect(shard?.name).not.toContain("00001");
    expect(shard?.quant).toBe("Q6_K");
  });

  test("non-gguf files are ignored", async () => {
    const dir = await setup();
    const models = (await discoverModels({ extraPaths: [dir] })).filter((m) =>
      m.path.startsWith(dir),
    );
    expect(models.some((m) => m.path.endsWith("README.txt"))).toBe(false);
  });

  test("missing extra paths are skipped silently", async () => {
    const models = await discoverModels({
      extraPaths: [join(tmpdir(), "llamactl-does-not-exist-zzz")],
    });
    expect(Array.isArray(models)).toBe(true);
  });
});
