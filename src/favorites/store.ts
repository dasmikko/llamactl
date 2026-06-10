/**
 * Favorites store: a persisted set of row ids the user has starred so they
 * float to the top of the model list. A favorite keys on the row's id — a
 * discovered model id, or an instance id for a profile with no discovered
 * model — so it survives re-sorts the same way the TUI cursor does.
 *
 * Persisted as JSON (`{ "favorites": [...] }`) and written atomically (temp
 * file + rename). A corrupt file must never brick the daemon, so a malformed
 * file is logged and treated as empty.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FavoriteStore } from "../types.ts";
import { favoritesPath } from "../config/paths.ts";

/** On-disk shape: an object with a string array, so the file is self-describing. */
interface StoreFile {
  favorites: string[];
}

/**
 * Load (or initialise) the favorites store. Reads the JSON file at `path` if
 * present; returns an empty store if absent; on a malformed file logs a warning
 * to stderr and starts empty rather than throwing.
 */
export async function loadFavoriteStore(path = favoritesPath()): Promise<FavoriteStore> {
  const ids = new Set<string>();

  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = JSON.parse(await file.text()) as StoreFile;
      if (parsed && Array.isArray(parsed.favorites)) {
        for (const id of parsed.favorites) {
          if (typeof id === "string" && id.length > 0) ids.add(id);
        }
      } else {
        console.warn(`llamactl: favorites file at ${path} is malformed; starting empty`);
      }
    } catch (e) {
      console.warn(
        `llamactl: favorites file at ${path} is not valid JSON; starting empty: ${
          (e as Error).message
        }`,
      );
    }
  }

  /** Serialize the in-memory set to disk atomically (temp file + rename). */
  async function persist(): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const obj: StoreFile = { favorites: [...ids].sort() };
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, path);
  }

  return {
    list(): string[] {
      return [...ids].sort();
    },

    has(id: string): boolean {
      return ids.has(id);
    },

    async toggle(id: string): Promise<boolean> {
      const nowFavorited = !ids.has(id);
      if (nowFavorited) ids.add(id);
      else ids.delete(id);
      await persist();
      return nowFavorited;
    },
  };
}
