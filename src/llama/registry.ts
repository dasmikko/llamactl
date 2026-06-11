/**
 * Persisted registry of managed llama.cpp installs. Mirrors the favorites store
 * style: a self-describing JSON file written atomically (temp file + rename), and
 * a malformed file must never brick the daemon — it is logged to stderr and the
 * registry starts empty.
 *
 * The registry only tracks records; it owns no filesystem under the install dirs
 * (the InstallManager does that). The file path is passed in so it stays
 * unit-testable against a temp dir.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LlamaInstall } from "../types.ts";

/** On-disk shape: the list of installs plus the active id (or null for PATH). */
export interface RegistryFile {
  installs: LlamaInstall[];
  activeId: string | null;
}

/**
 * In-memory, persistable registry of installs. Construct via {@link loadRegistry}
 * so a malformed file is handled uniformly.
 */
export class InstallRegistry {
  private readonly path: string;
  private readonly installList: LlamaInstall[];
  private activeId: string | null;

  constructor(path: string, file: RegistryFile) {
    this.path = path;
    this.installList = file.installs;
    this.activeId = file.activeId;
  }

  /** Snapshot of all installs (most-recently-built first). */
  list(): LlamaInstall[] {
    return [...this.installList].sort((a, b) => b.builtAt - a.builtAt);
  }

  get(id: string): LlamaInstall | undefined {
    return this.installList.find((i) => i.id === id);
  }

  /** Add (or replace, by id) an install record. Does not persist. */
  add(install: LlamaInstall): void {
    const idx = this.installList.findIndex((i) => i.id === install.id);
    if (idx >= 0) this.installList[idx] = install;
    else this.installList.push(install);
  }

  /** Rename an install by id; returns true if one was found. Does not persist. */
  rename(id: string, name: string): boolean {
    const install = this.installList.find((i) => i.id === id);
    if (!install) return false;
    install.name = name;
    return true;
  }

  /** Remove an install by id; returns true if one was removed. Does not persist. */
  remove(id: string): boolean {
    const idx = this.installList.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.installList.splice(idx, 1);
    if (this.activeId === id) this.activeId = null;
    return true;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /** Set the active id (no validation here; the manager validates). Does not persist. */
  setActiveId(id: string | null): void {
    this.activeId = id;
  }

  /** Serialize the registry to disk atomically (temp file + rename). */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const obj: RegistryFile = { installs: this.installList, activeId: this.activeId };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, this.path);
  }
}

/**
 * Load (or initialise) the install registry at `path`. Returns an empty registry
 * if the file is absent; on a malformed file logs a warning to stderr and starts
 * empty rather than throwing.
 */
export async function loadRegistry(path: string): Promise<InstallRegistry> {
  const empty: RegistryFile = { installs: [], activeId: null };

  const file = Bun.file(path);
  if (!(await file.exists())) return new InstallRegistry(path, empty);

  try {
    const parsed = JSON.parse(await file.text()) as Partial<RegistryFile>;
    if (parsed && Array.isArray(parsed.installs)) {
      const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
      return new InstallRegistry(path, { installs: parsed.installs, activeId });
    }
    console.warn(`llamactl: install registry at ${path} is malformed; starting empty`);
  } catch (e) {
    console.warn(
      `llamactl: install registry at ${path} is not valid JSON; starting empty: ${
        (e as Error).message
      }`,
    );
  }
  return new InstallRegistry(path, empty);
}
