import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGgufMeta } from "../src/discovery/gguf.ts";

/* Minimal little-endian GGUF header builder. */
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u64(n: number): number[] {
  return [...u32(n), 0, 0, 0, 0]; // test values fit in 32 bits
}
function gstr(s: string): number[] {
  const b = [...Buffer.from(s, "utf8")];
  return [...u64(b.length), ...b];
}
const T_UINT32 = 4;
const T_STRING = 8;
function kvStr(key: string, val: string): number[] {
  return [...gstr(key), ...u32(T_STRING), ...gstr(val)];
}
function kvU32(key: string, val: number): number[] {
  return [...gstr(key), ...u32(T_UINT32), ...u32(val)];
}
function gguf(kvs: number[][]): Buffer {
  const bytes = [
    ...[0x47, 0x47, 0x55, 0x46], // "GGUF"
    ...u32(3), // version
    ...u64(0), // tensor count
    ...u64(kvs.length), // kv count
    ...kvs.flat(),
  ];
  return Buffer.from(bytes);
}

async function writeGguf(dir: string, name: string, kvs: number[][]): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, gguf(kvs));
  return p;
}

describe("readGgufMeta", () => {
  let dir: string;
  test("setup", async () => {
    dir = await mkdtemp(join(tmpdir(), "llamactl-gguf-"));
  });

  test("reads arch and context length; kind text", async () => {
    const p = await writeGguf(dir, "m.gguf", [
      kvStr("general.architecture", "llama"),
      kvU32("llama.context_length", 32768),
    ]);
    const meta = await readGgufMeta(p);
    expect(meta.arch).toBe("llama");
    expect(meta.contextLength).toBe(32768);
    expect(meta.kind).toBe("text");
  });

  test("clip architecture ⇒ vision", async () => {
    const p = await writeGguf(dir, "v.gguf", [kvStr("general.architecture", "clip")]);
    const meta = await readGgufMeta(p);
    expect(meta.kind).toBe("vision");
  });

  test("mmproj filename ⇒ vision even without clip arch", async () => {
    const p = await writeGguf(dir, "mmproj-model.gguf", [
      kvStr("general.architecture", "qwen2"),
    ]);
    const meta = await readGgufMeta(p);
    expect(meta.kind).toBe("vision");
  });

  test("pooling_type key ⇒ embedding", async () => {
    const p = await writeGguf(dir, "e.gguf", [
      kvStr("general.architecture", "nomic-bert"),
      kvU32("nomic-bert.pooling_type", 1),
    ]);
    const meta = await readGgufMeta(p);
    expect(meta.kind).toBe("embedding");
  });

  test("non-GGUF file ⇒ null fallback", async () => {
    const p = join(dir, "not.gguf");
    await writeFile(p, "this is not a gguf file");
    const meta = await readGgufMeta(p);
    expect(meta.arch).toBeNull();
    expect(meta.contextLength).toBeNull();
    expect(meta.kind).toBe("text");
  });

  test("teardown", async () => {
    await rm(dir, { recursive: true, force: true });
  });
});
