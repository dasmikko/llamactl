import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFavoriteStore } from "../src/favorites/store.ts";

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llamactl-fav-"));
  return join(dir, "favorites.json");
}

describe("loadFavoriteStore", () => {
  test("empty by default; toggle adds, returns true, persists", async () => {
    const path = await tempStorePath();
    const store = await loadFavoriteStore(path);
    expect(store.list()).toEqual([]);
    expect(store.has("alpha")).toBe(false);

    expect(await store.toggle("alpha")).toBe(true);
    expect(store.has("alpha")).toBe(true);

    // A fresh load sees the persisted favorite.
    const reloaded = await loadFavoriteStore(path);
    expect(reloaded.list()).toEqual(["alpha"]);
  });

  test("toggle is a flip: second call removes and returns false", async () => {
    const store = await loadFavoriteStore(await tempStorePath());
    await store.toggle("m");
    expect(await store.toggle("m")).toBe(false);
    expect(store.has("m")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("list is sorted and de-duplicated", async () => {
    const store = await loadFavoriteStore(await tempStorePath());
    await store.toggle("gamma");
    await store.toggle("alpha");
    await store.toggle("beta");
    expect(store.list()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("malformed file does not throw; starts empty", async () => {
    const path = await tempStorePath();
    await writeFile(path, "not json at all", "utf8");
    const store = await loadFavoriteStore(path);
    expect(store.list()).toEqual([]);
    // And it can still be written to.
    expect(await store.toggle("x")).toBe(true);
  });

  test("ignores non-string / empty entries in the file", async () => {
    const path = await tempStorePath();
    await writeFile(path, JSON.stringify({ favorites: ["ok", "", 42, null] }), "utf8");
    const store = await loadFavoriteStore(path);
    expect(store.list()).toEqual(["ok"]);
  });
});
