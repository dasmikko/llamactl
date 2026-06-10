/**
 * Saved-profile store for llama-server launch configs. Persists named
 * `InstanceConfig` profiles to a JSON file (an object keyed by slug id) and
 * serves CRUD through the frozen `InstanceStore` seam. A corrupt file must
 * never brick the daemon, so a malformed file is logged and treated as empty.
 * Writes are atomic (temp file + rename) so a crash mid-write can't truncate.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstanceConfig, InstanceStore, LaunchSpec } from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { instancesPath } from "../config/paths.ts";
import { validateSpec } from "./spec.ts";

/** On-disk shape: a JSON object keyed by instance id. */
type StoreFile = Record<string, InstanceConfig>;

/**
 * Derive a stable slug id from a string. Lowercases, replaces any run of
 * non-`[a-z0-9]` characters with a single `-`, trims leading/trailing `-`,
 * and falls back to `"instance"` if nothing usable remains.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "instance";
}

/**
 * Load (or initialise) the saved-instance store. Reads the JSON file at `path`
 * if present; returns an empty store if absent; on a malformed file logs a
 * warning to stderr and starts empty rather than throwing.
 */
export async function loadInstanceStore(path = instancesPath()): Promise<InstanceStore> {
  const byId = new Map<string, InstanceConfig>();

  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = JSON.parse(await file.text()) as StoreFile;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, config] of Object.entries(parsed)) {
          byId.set(id, config);
        }
      } else {
        console.warn(`llamactl: instances file at ${path} is not an object; starting empty`);
      }
    } catch (e) {
      console.warn(
        `llamactl: instances file at ${path} is not valid JSON; starting empty: ${
          (e as Error).message
        }`,
      );
    }
  }

  /** Serialize the in-memory map to disk atomically (temp file + rename). */
  async function persist(): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const obj: StoreFile = {};
    for (const [id, config] of byId) obj[id] = config;
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, path);
  }

  return {
    list(): InstanceConfig[] {
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    get(id: string): InstanceConfig | undefined {
      return byId.get(id);
    },

    async create(input: { id?: string; name?: string; spec: LaunchSpec }): Promise<InstanceConfig> {
      validateSpec(input.spec);
      // An explicit id (a model's inline config) or an explicit name both map to
      // exactly one id and collide loudly. A blank name defaults to the model's
      // slug, so several profiles for the same model would collide —
      // disambiguate those with a numeric suffix instead.
      let id: string;
      if (input.id !== undefined || input.name !== undefined) {
        id = input.id ?? slugify(input.name!);
        if (byId.has(id)) {
          throw new LlamactlError("instance_exists", `an instance with id "${id}" already exists`, {
            detail: { id },
          });
        }
      } else {
        const base = slugify(input.spec.model);
        id = base;
        for (let n = 2; byId.has(id); n++) id = `${base}-${n}`;
      }
      const now = Date.now();
      const config: InstanceConfig = {
        id,
        name: input.name ?? id,
        spec: input.spec,
        createdAt: now,
        updatedAt: now,
      };
      byId.set(id, config);
      await persist();
      return config;
    },

    async update(
      id: string,
      patch: { name?: string; spec?: LaunchSpec },
    ): Promise<InstanceConfig> {
      const existing = byId.get(id);
      if (!existing) {
        throw new LlamactlError("instance_not_found", `no instance with id "${id}"`, {
          detail: { id },
        });
      }
      if (patch.spec !== undefined) validateSpec(patch.spec);
      const updated: InstanceConfig = {
        id: existing.id,
        name: patch.name ?? existing.name,
        spec: patch.spec ?? existing.spec,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      };
      byId.set(id, updated);
      await persist();
      return updated;
    },

    async remove(id: string): Promise<void> {
      if (!byId.has(id)) {
        throw new LlamactlError("instance_not_found", `no instance with id "${id}"`, {
          detail: { id },
        });
      }
      byId.delete(id);
      await persist();
    },
  };
}
