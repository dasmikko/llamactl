import { describe, expect, test } from "bun:test";

import type { Model } from "../src/types.ts";
import {
  createResolver,
  resolveModel,
  parseRepo,
  isProjector,
  runnableModels,
} from "../src/discovery/models.ts";
import { LlamactlError, isLlamactlError } from "../src/errors.ts";

describe("parseRepo", () => {
  test("decodes the repo from an HF hub cache path", () => {
    const p =
      "/home/u/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/abc/gemma.gguf";
    expect(parseRepo(p)).toBe("unsloth/gemma-4-E2B-it-GGUF");
  });
  test("handles an org containing a dash", () => {
    const p = "/x/hub/models--lmstudio-community--Qwen3.5-9B-GGUF/snapshots/a/m.gguf";
    expect(parseRepo(p)).toBe("lmstudio-community/Qwen3.5-9B-GGUF");
  });
  test("uses the org/name layout (LM Studio) when not an HF cache path", () => {
    expect(parseRepo("/home/u/.lmstudio/models/unsloth/Qwen3.5-9B-GGUF/m.gguf")).toBe(
      "unsloth/Qwen3.5-9B-GGUF",
    );
  });
  test("returns null when no repo is apparent", () => {
    expect(parseRepo("/srv/m.gguf")).toBeNull();
  });
});

const models: Model[] = [
  {
    id: "llama-3.1-8b-instruct-q4_k_m",
    name: "Llama 3.1 8B Instruct",
    path: "/models/llama-3.1-8B-Instruct-Q4_K_M.gguf",
    sizeBytes: 1000,
    quant: "Q4_K_M",
    source: "huggingface",
    mtimeMs: 1,
    arch: null,
    contextLength: null,
    nLayers: null,
    kvDim: null,
    kind: "text",
    org: null,
    repo: null,
  },
  {
    id: "llama-3.1-8b-instruct-q8_0",
    name: "Llama 3.1 8B Instruct",
    path: "/models/llama-3.1-8B-Instruct-Q8_0.gguf",
    sizeBytes: 2000,
    quant: "Q8_0",
    source: "huggingface",
    mtimeMs: 2,
    arch: null,
    contextLength: null,
    nLayers: null,
    kvDim: null,
    kind: "text",
    org: null,
    repo: null,
  },
  {
    id: "mistral-7b-q4_k_m",
    name: "Mistral 7B",
    path: "/cfg/Mistral-7B-Q4_K_M.gguf",
    sizeBytes: 3000,
    quant: "Q4_K_M",
    source: "config",
    mtimeMs: 3,
    arch: null,
    contextLength: null,
    nLayers: null,
    kvDim: null,
    kind: "text",
    org: null,
    repo: null,
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
    expect(isLlamactlError(err)).toBe(true);
    expect(err).toBeInstanceOf(LlamactlError);
    expect((err as LlamactlError).code).toBe("ambiguous_model");
    // Message should list candidate ids.
    expect((err as LlamactlError).message).toContain("llama-3.1-8b-instruct-q4_k_m");
    expect((err as LlamactlError).message).toContain("llama-3.1-8b-instruct-q8_0");
  });

  test("missing selector throws model_not_found", () => {
    let err: unknown;
    try {
      resolveModel(models, "does-not-exist-xyz");
    } catch (e) {
      err = e;
    }
    expect(isLlamactlError(err)).toBe(true);
    expect(err).toBeInstanceOf(LlamactlError);
    expect((err as LlamactlError).code).toBe("model_not_found");
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

  test("resolve throws LlamactlError on miss", () => {
    const r = createResolver(models);
    expect(() => r.resolve("nope-nope")).toThrow(LlamactlError);
  });
});

describe("runnableModels", () => {
  const projector: Model = {
    id: "llava-mmproj-f16",
    name: "LLaVA mmproj",
    path: "/models/llava-mmproj-f16.gguf",
    sizeBytes: 500,
    quant: null,
    source: "huggingface",
    mtimeMs: 4,
    arch: "clip",
    contextLength: null,
    nLayers: null,
    kvDim: null,
    kind: "vision",
    org: null,
    repo: null,
  };

  test("isProjector flags only vision (mmproj) files", () => {
    expect(isProjector(projector)).toBe(true);
    expect(isProjector(models[0]!)).toBe(false);
  });

  test("runnableModels drops projector files but keeps text models", () => {
    const filtered = runnableModels([...models, projector]);
    expect(filtered.map((m) => m.id)).not.toContain("llava-mmproj-f16");
    expect(filtered.length).toBe(models.length);
  });
});
