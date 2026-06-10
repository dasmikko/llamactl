import { describe, expect, test } from "bun:test";
import { buildRows } from "../src/tui/rows.ts";
import type { InstanceConfig, Model, RunningModel } from "../src/types.ts";

function model(id: string, name = id): Model {
  return {
    id,
    name,
    path: `/models/${id}.gguf`,
    sizeBytes: 1024,
    quant: "Q4_K_M",
    source: "path",
    mtimeMs: 0,
    arch: "llama",
    contextLength: 4096,
    nLayers: 32,
    kvDim: 128,
    kind: "text",
    org: null,
  };
}

function instance(id: string, modelSelector: string, name = id): InstanceConfig {
  return {
    id,
    name,
    spec: { model: modelSelector },
    createdAt: 0,
    updatedAt: 0,
  };
}

function running(modelId: string): RunningModel {
  return {
    modelId,
    name: modelId,
    path: `/models/${modelId}.gguf`,
    pid: 4242,
    port: 8080,
    status: "ready",
    startedAt: 0,
    restarts: 0,
    logPath: "/tmp/x.log",
    spec: { model: modelId },
  };
}

describe("buildRows", () => {
  test("each model gets a base row with a unique key", () => {
    const rows = buildRows([model("a"), model("b")], [], [], null);
    expect(rows.map((r) => r.key)).toEqual(["m:a", "m:b"]);
    expect(rows.every((r) => r.instance === undefined)).toBe(true);
    expect(rows.every((r) => !r.isExtraProfile)).toBe(true);
  });

  test("inline config (id === model id) merges into the model row, not a child", () => {
    const rows = buildRows(
      [model("qwen")],
      [instance("qwen", "qwen", "qwen")],
      [],
      null,
    );
    // Just the model row — the inline profile rides on it (one line).
    expect(rows.map((r) => r.key)).toEqual(["m:qwen"]);
    expect(rows[0]!.instance?.id).toBe("qwen");
    expect(rows[0]!.isExtraProfile).toBe(false);
  });

  test("inline config merges even when the model id has dots/underscores", () => {
    // Regression: the store's slugify mangles "qwen2.5" → "qwen2-5"; the inline
    // config is created with the exact model id, so it must still merge inline.
    const rows = buildRows(
      [model("qwen2.5-7b")],
      [instance("qwen2.5-7b", "qwen2.5-7b", "qwen2.5-7b")],
      [],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(["m:qwen2.5-7b"]);
    expect(rows[0]!.instance?.id).toBe("qwen2.5-7b");
    expect(rows[0]!.isExtraProfile).toBe(false);
  });

  test("additional profiles render as indented child rows under the model", () => {
    const rows = buildRows(
      [model("qwen")],
      [
        instance("qwen", "qwen", "qwen"), // inline
        instance("qwen-2", "qwen", "long-ctx"),
        instance("qwen-3", "qwen", "cpu"),
      ],
      [],
      null,
    );
    // Inline merges onto the model row; the extras are children beneath it,
    // sorted by display name ("cpu" before "long-ctx").
    expect(rows.map((r) => r.key)).toEqual(["m:qwen", "i:qwen-3", "i:qwen-2"]);
    expect(rows[0]!.isExtraProfile).toBe(false);
    expect(rows.slice(1).every((r) => r.isExtraProfile)).toBe(true);
    expect(rows.slice(1).every((r) => r.groupId === "qwen")).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  test("profiles sort beneath their own model, not another", () => {
    const rows = buildRows(
      [model("alpha"), model("beta")],
      [instance("b1", "beta"), instance("a1", "alpha")],
      [],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(["m:alpha", "i:a1", "m:beta", "i:b1"]);
  });

  test("a profile whose model isn't discovered stands as its own row", () => {
    const rows = buildRows([], [instance("ghost", "not-here")], [], null);
    expect(rows.map((r) => r.key)).toEqual(["i:ghost"]);
    expect(rows[0]!.model).toBeUndefined();
    expect(rows[0]!.modelId).toBe("ghost");
  });

  test("running model floats to the top and carries the running child", () => {
    const rows = buildRows(
      [model("a"), model("b")],
      [],
      [running("b")],
      null,
    );
    expect(rows[0]!.key).toBe("m:b");
    expect(rows[0]!.running).toBeDefined();
  });

  test("favorites float above the rest by favoriteId", () => {
    const rows = buildRows(
      [model("a"), model("b")],
      [instance("p", "a", "prof")],
      [],
      null,
      new Set(["p"]),
    );
    // The favorited profile floats above the plain model rows.
    expect(rows[0]!.key).toBe("i:p");
    expect(rows[0]!.isFavorite).toBe(true);
  });
});
