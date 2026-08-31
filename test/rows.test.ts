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
    nEmbd: null,
    nHeads: null,
    nextnLayers: null,
    kind: "text",
    org: null,
    repo: null,
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
  test("each model gets a base row with a unique key and no profiles", () => {
    const rows = buildRows([model("a"), model("b")], [], [], null);
    expect(rows.map((r) => r.key)).toEqual(["m:a", "m:b"]);
    expect(rows.every((r) => r.instance === undefined)).toBe(true);
    expect(rows.every((r) => r.profiles.length === 0)).toBe(true);
  });

  test("a model's profile attaches to its row, not a separate row", () => {
    const rows = buildRows(
      [model("qwen")],
      [instance("qwen", "qwen", "qwen")],
      [],
      null,
    );
    // Just the model row — the profile hangs off it (chosen from the picker).
    expect(rows.map((r) => r.key)).toEqual(["m:qwen"]);
    expect(rows[0]!.instance).toBeUndefined();
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["qwen"]);
  });

  test("profiles attach even when the model id has dots/underscores", () => {
    // The store's slugify mangles "qwen2.5" → "qwen2-5"; a profile created with
    // the exact model id must still resolve to its model.
    const rows = buildRows(
      [model("qwen2.5-7b")],
      [instance("qwen2.5-7b", "qwen2.5-7b", "qwen2.5-7b")],
      [],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(["m:qwen2.5-7b"]);
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["qwen2.5-7b"]);
  });

  test("all of a model's profiles attach to its single row, sorted by name", () => {
    const rows = buildRows(
      [model("qwen")],
      [
        instance("qwen", "qwen", "qwen"),
        instance("qwen-2", "qwen", "long-ctx"),
        instance("qwen-3", "qwen", "cpu"),
      ],
      [],
      null,
    );
    // One row for the model; every profile hangs off it, sorted by display name.
    expect(rows.map((r) => r.key)).toEqual(["m:qwen"]);
    expect(rows[0]!.profiles.map((p) => p.name)).toEqual(["cpu", "long-ctx", "qwen"]);
  });

  test("each model carries only its own profiles", () => {
    const rows = buildRows(
      [model("alpha"), model("beta")],
      [instance("b1", "beta"), instance("a1", "alpha")],
      [],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(["m:alpha", "m:beta"]);
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["a1"]);
    expect(rows[1]!.profiles.map((p) => p.id)).toEqual(["b1"]);
  });

  test("a profile whose model isn't discovered stands as its own row", () => {
    const rows = buildRows([], [instance("ghost", "not-here")], [], null);
    expect(rows.map((r) => r.key)).toEqual(["i:ghost"]);
    expect(rows[0]!.model).toBeUndefined();
    expect(rows[0]!.modelId).toBe("ghost");
    expect(rows[0]!.instance?.id).toBe("ghost");
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["ghost"]);
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

  test("favoriting a profile floats its model row above the rest", () => {
    const rows = buildRows(
      [model("a"), model("b")],
      [instance("p", "a", "prof")],
      [],
      null,
      new Set(["p"]),
    );
    // The profile has no row of its own; starring it floats its model's row.
    expect(rows.map((r) => r.key)).toEqual(["m:a", "m:b"]);
    expect(rows[0]!.isFavorite).toBe(true);
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["p"]);
    expect(rows[1]!.isFavorite).toBe(false);
  });

  test("catalog rows cluster by repo, repo-less rows sort last", () => {
    const withRepo = (id: string, repo: string | null): Model => ({
      ...model(id),
      repo,
    });
    const rows = buildRows(
      [
        withRepo("z-local", null),
        withRepo("nomic-q4", "nomic-ai/nomic-embed"),
        withRepo("bart-q8", "bartowski/qwen"),
        withRepo("nomic-q2", "nomic-ai/nomic-embed"),
      ],
      [],
      [],
      null,
    );
    // bartowski < nomic-ai by repo; within nomic the two variants sort by name;
    // the repo-less local file sinks to the bottom.
    expect(rows.map((r) => r.key)).toEqual([
      "m:bart-q8",
      "m:nomic-q2",
      "m:nomic-q4",
      "m:z-local",
    ]);
    expect(rows[3]!.repo).toBeNull();
  });

  test("a row's repo falls back to org when no repo is parsed", () => {
    const rows = buildRows([{ ...model("a"), repo: null, org: "unsloth" }], [], [], null);
    expect(rows[0]!.repo).toBe("unsloth");
  });

  test("favoriting a model floats its row up with its profiles attached", () => {
    const rows = buildRows(
      [model("a"), model("b")],
      [instance("p", "a", "prof")],
      [],
      null,
      new Set(["a"]),
    );
    expect(rows.map((r) => r.key)).toEqual(["m:a", "m:b"]);
    expect(rows[0]!.isFavorite).toBe(true);
    expect(rows[0]!.profiles.map((p) => p.id)).toEqual(["p"]);
    expect(rows[1]!.isFavorite).toBe(false);
  });
});
