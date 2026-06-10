import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLlamactlError } from "../src/errors.ts";
import { loadInstanceStore } from "../src/instances/store.ts";

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llamactl-store-"));
  return join(dir, "instances.json");
}

describe("loadInstanceStore", () => {
  test("create + get + list, sorted by id", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const b = await store.create({ name: "Beta", spec: { model: "m1" } });
    const a = await store.create({ name: "Alpha", spec: { model: "m2" } });

    expect(store.get(a.id)).toEqual(a);
    expect(store.get(b.id)).toEqual(b);
    expect(store.get("missing")).toBeUndefined();
    expect(store.list().map((c) => c.id)).toEqual(["alpha", "beta"]);
  });

  test("slug derives from name when given", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const c = await store.create({ name: "My Cool Model!!", spec: { model: "x" } });
    expect(c.id).toBe("my-cool-model");
    expect(c.name).toBe("My Cool Model!!");
  });

  test("slug derives from model when no name, name defaults to slug", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const c = await store.create({ spec: { model: "Llama-3.1 8B/Q4_K_M" } });
    expect(c.id).toBe("llama-3-1-8b-q4-k-m");
    expect(c.name).toBe("llama-3-1-8b-q4-k-m");
  });

  test("slug falls back to 'instance' when empty", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const c = await store.create({ name: "!!!", spec: { model: "x" } });
    expect(c.id).toBe("instance");
  });

  test("duplicate create throws instance_exists", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    await store.create({ name: "dup", spec: { model: "x" } });
    try {
      await store.create({ name: "dup", spec: { model: "y" } });
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("instance_exists");
    }
  });

  test("explicit id is used verbatim (not slugified) and collides loudly", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    // A model id keeps dots/underscores that slugify() would strip, so the
    // inline config must be created under the exact id.
    const c = await store.create({ id: "qwen2.5-7b_q4", spec: { model: "qwen2.5-7b_q4" } });
    expect(c.id).toBe("qwen2.5-7b_q4");
    try {
      await store.create({ id: "qwen2.5-7b_q4", spec: { model: "x" } });
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("instance_exists");
    }
  });

  test("blank-name profiles for the same model auto-disambiguate the id", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const a = await store.create({ spec: { model: "qwen" } });
    const b = await store.create({ spec: { model: "qwen" } });
    const c = await store.create({ spec: { model: "qwen" } });
    expect([a.id, b.id, c.id]).toEqual(["qwen", "qwen-2", "qwen-3"]);
    expect(store.list().map((x) => x.id)).toEqual(["qwen", "qwen-2", "qwen-3"]);
  });

  test("update changes spec, bumps updatedAt, keeps createdAt and id", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const created = await store.create({ name: "u", spec: { model: "x", ctxSize: 1024 } });
    await Bun.sleep(2);
    const updated = await store.update(created.id, { spec: { model: "x", ctxSize: 2048 } });

    expect(updated.id).toBe(created.id);
    expect(updated.spec.ctxSize).toBe(2048);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  test("update missing id throws instance_not_found", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    try {
      await store.update("nope", { name: "x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("instance_not_found");
    }
  });

  test("remove deletes; remove missing id throws instance_not_found", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    const c = await store.create({ name: "r", spec: { model: "x" } });
    await store.remove(c.id);
    expect(store.get(c.id)).toBeUndefined();
    try {
      await store.remove(c.id);
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("instance_not_found");
    }
  });

  test("invalid spec rejected via invalid_spec on create and update", async () => {
    const store = await loadInstanceStore(await tempStorePath());
    try {
      await store.create({ name: "bad", spec: { model: "" } });
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("invalid_spec");
    }

    const good = await store.create({ name: "good", spec: { model: "x" } });
    try {
      await store.update(good.id, { spec: { model: "x", ctxSize: -1 } });
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("invalid_spec");
    }
  });

  test("persists across a reload of the same path", async () => {
    const path = await tempStorePath();
    const store = await loadInstanceStore(path);
    const created = await store.create({ name: "Persisted", spec: { model: "m", gpuLayers: 99 } });

    const reloaded = await loadInstanceStore(path);
    const got = reloaded.get(created.id);
    expect(got).toEqual(created);
    expect(reloaded.list()).toHaveLength(1);
  });

  test("malformed file yields empty store without throwing", async () => {
    const path = await tempStorePath();
    await writeFile(path, "{ this is not json");
    const store = await loadInstanceStore(path);
    expect(store.list()).toEqual([]);
    // and it remains usable
    const c = await store.create({ name: "ok", spec: { model: "x" } });
    expect(c.id).toBe("ok");
  });
});
