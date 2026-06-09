/**
 * Unit tests for the pure Hugging Face client helpers. No network access:
 * `fileUrl`, `parseSearch`, and `parseTree` are exercised directly.
 */

import { describe, expect, test } from "bun:test";

import { HF_BASE, fileUrl, parseSearch, parseTree } from "../src/hf/client.ts";

describe("fileUrl", () => {
  test("builds a resolve URL with download=true at the default revision", () => {
    expect(fileUrl("TheBloke/Llama-2-7B-GGUF", "llama-2-7b.Q4_K_M.gguf")).toBe(
      `${HF_BASE}/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf?download=true`,
    );
  });

  test("honours a custom revision", () => {
    expect(fileUrl("org/repo", "model.gguf", "abc123")).toBe(
      `${HF_BASE}/org/repo/resolve/abc123/model.gguf?download=true`,
    );
  });

  test("encodes each path segment but keeps the slashes", () => {
    const url = fileUrl("org/repo", "sub dir/my model.gguf");
    expect(url).toBe(`${HF_BASE}/org/repo/resolve/main/sub%20dir/my%20model.gguf?download=true`);
    // Slashes between segments are preserved (not encoded).
    expect(url).toContain("/sub%20dir/my%20model.gguf");
  });
});

describe("parseSearch", () => {
  test("maps id, likes, downloads, updatedAt and gated", () => {
    const repos = parseSearch([
      {
        id: "org/a",
        likes: 5,
        downloads: 100,
        lastModified: "2024-01-01T00:00:00.000Z",
        gated: false,
      },
    ]);
    expect(repos).toEqual([
      { id: "org/a", likes: 5, downloads: 100, updatedAt: "2024-01-01T00:00:00.000Z", gated: false },
    ]);
  });

  test("falls back to modelId and updatedAt field names", () => {
    const repos = parseSearch([{ modelId: "org/b", updatedAt: "2023-05-05T00:00:00.000Z" }]);
    expect(repos[0]?.id).toBe("org/b");
    expect(repos[0]?.updatedAt).toBe("2023-05-05T00:00:00.000Z");
    // Missing numeric fields default to 0.
    expect(repos[0]?.likes).toBe(0);
    expect(repos[0]?.downloads).toBe(0);
  });

  test("treats gated variants false/auto/true correctly", () => {
    const repos = parseSearch([
      { id: "org/not-gated", gated: false },
      { id: "org/auto", gated: "auto" },
      { id: "org/manual", gated: "manual" },
      { id: "org/true", gated: true },
    ]);
    expect(repos.map((r) => r.gated)).toEqual([false, true, true, true]);
  });

  test("skips items without a string id", () => {
    const repos = parseSearch([{ likes: 3 }, { id: 42 }, { id: "org/ok" }]);
    expect(repos.map((r) => r.id)).toEqual(["org/ok"]);
  });

  test("returns [] for non-array input", () => {
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({})).toEqual([]);
  });
});

describe("parseTree", () => {
  test("keeps only .gguf files, dropping dirs and non-gguf files", () => {
    const files = parseTree([
      { type: "directory", path: "subdir" },
      { type: "file", path: "README.md", size: 10 },
      { type: "file", path: "model.Q4_K_M.gguf", size: 12345 },
      { type: "file", path: "config.json", size: 20 },
    ]);
    expect(files.map((f) => f.rfilename)).toEqual(["model.Q4_K_M.gguf"]);
  });

  test("parses size and quant from the basename", () => {
    const files = parseTree([
      { type: "file", path: "weights/llama.Q8_0.gguf", size: 999 },
      { type: "file", path: "weights/unknown.gguf" },
    ]);
    const byName = new Map(files.map((f) => [f.rfilename, f]));
    expect(byName.get("weights/llama.Q8_0.gguf")).toEqual({
      rfilename: "weights/llama.Q8_0.gguf",
      sizeBytes: 999,
      quant: "Q8_0",
    });
    // Missing size → null; no quant token → null.
    expect(byName.get("weights/unknown.gguf")).toEqual({
      rfilename: "weights/unknown.gguf",
      sizeBytes: null,
      quant: null,
    });
  });

  test("matches .gguf case-insensitively and sorts by rfilename", () => {
    const files = parseTree([
      { type: "file", path: "b.GGUF", size: 1 },
      { type: "file", path: "a.gguf", size: 2 },
    ]);
    expect(files.map((f) => f.rfilename)).toEqual(["a.gguf", "b.GGUF"]);
  });

  test("returns [] for non-array input", () => {
    expect(parseTree(null)).toEqual([]);
    expect(parseTree("nope")).toEqual([]);
  });
});
