import { describe, expect, test } from "bun:test";

import type { Model } from "../src/types.ts";
import { createResolver, resolveModel } from "../src/discovery/models.ts";
import { BunstashError, isBunstashError } from "../src/errors.ts";

const models: Model[] = [
  {
    id: "llama-3.1-8b-instruct-q4_k_m",
    name: "Llama 3.1 8B Instruct",
    path: "/models/llama-3.1-8B-Instruct-Q4_K_M.gguf",
    sizeBytes: 1000,
    quant: "Q4_K_M",
    source: "huggingface",
    mtimeMs: 1,
  },
  {
    id: "llama-3.1-8b-instruct-q8_0",
    name: "Llama 3.1 8B Instruct",
    path: "/models/llama-3.1-8B-Instruct-Q8_0.gguf",
    sizeBytes: 2000,
    quant: "Q8_0",
    source: "huggingface",
    mtimeMs: 2,
  },
  {
    id: "mistral-7b-q4_k_m",
    name: "Mistral 7B",
    path: "/cfg/Mistral-7B-Q4_K_M.gguf",
    sizeBytes: 3000,
    quant: "Q4_K_M",
    source: "config",
    mtimeMs: 3,
  },
];

describe("resolveModel", () => {
  test("exact id match", () => {
    const m = resolveModel(models, "mistral-7b-q4_k_m");
    expect(m.id).toBe("mistral-7b-q4_k_m");
  });

  test("exact absolute path match", () => {
    const m = resolveModel(models, "/cfg/Mistral-7B-Q4_K_M.gguf");
    expect(m.id).toBe("mistral-7b-q4_k_m");
  });

  test("exact name match is case-insensitive", () => {
    const m = resolveModel(models, "mISTRAL 7b");
    expect(m.id).toBe("mistral-7b-q4_k_m");
  });

  test("unique substring match", () => {
    const m = resolveModel(models, "mistral");
    expect(m.id).toBe("mistral-7b-q4_k_m");
  });

  test("unique substring match on id token", () => {
    const m = resolveModel(models, "q8_0");
    expect(m.id).toBe("llama-3.1-8b-instruct-q8_0");
  });

  test("ambiguous substring throws ambiguous_model", () => {
    let err: unknown;
    try {
      resolveModel(models, "llama");
    } catch (e) {
      err = e;
    }
    expect(isBunstashError(err)).toBe(true);
    expect(err).toBeInstanceOf(BunstashError);
    expect((err as BunstashError).code).toBe("ambiguous_model");
    // Message should list candidate ids.
    expect((err as BunstashError).message).toContain("llama-3.1-8b-instruct-q4_k_m");
    expect((err as BunstashError).message).toContain("llama-3.1-8b-instruct-q8_0");
  });

  test("missing selector throws model_not_found", () => {
    let err: unknown;
    try {
      resolveModel(models, "does-not-exist-xyz");
    } catch (e) {
      err = e;
    }
    expect(isBunstashError(err)).toBe(true);
    expect(err).toBeInstanceOf(BunstashError);
    expect((err as BunstashError).code).toBe("model_not_found");
  });

  test("exact id wins over substring ambiguity", () => {
    // "llama-3.1-8b-instruct-q8_0" is also a substring of nothing else, but
    // exact id must short-circuit before substring logic anyway.
    const m = resolveModel(models, "llama-3.1-8b-instruct-q8_0");
    expect(m.quant).toBe("Q8_0");
  });
});

describe("createResolver", () => {
  test("resolve delegates to resolveModel", () => {
    const r = createResolver(models);
    expect(r.resolve("mistral").id).toBe("mistral-7b-q4_k_m");
  });

  test("all() returns the model list", () => {
    const r = createResolver(models);
    expect(r.all()).toBe(models);
    expect(r.all().length).toBe(3);
  });

  test("resolve throws BunstashError on miss", () => {
    const r = createResolver(models);
    expect(() => r.resolve("nope-nope")).toThrow(BunstashError);
  });
});
