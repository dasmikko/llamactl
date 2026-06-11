/**
 * Row-join logic shared by the table and the app's key handling. A discovered
 * Model gets exactly one row that carries ALL of its saved profiles in
 * `profiles` (the launch picker and profile manager choose among them). Saved
 * profiles are no longer rows of their own — except an orphan profile, whose
 * model isn't discovered, which still appears as its own standalone row so it
 * stays reachable. Each row is annotated with its running state and per-instance
 * stats so the presentational Table is dumb.
 */

import type {
  Model,
  InstanceConfig,
  RunningModel,
  StatsSnapshot,
  InstanceStats,
  LaunchSpec,
} from "../types.ts";

/**
 * A merged, display-ready row. There is exactly one row per discovered model
 * (plus standalone rows for orphan profiles/running children). A model's saved
 * profiles are NOT separate rows anymore — they hang off `profiles` and are
 * chosen from the launch picker / profile manager instead.
 */
export interface Row {
  /** Unique, stable React/selection key for this row. */
  key: string;
  /** Canonical model id this row keys on (for running/stop/stats joins). */
  modelId: string;
  /** Id used in the favorites set for this row (model id or instance id). */
  favoriteId: string;
  /** Sort group: the parent model's id. */
  groupId: string;
  /** Sort group label: the parent model's display name. */
  groupName: string;
  /** Display name (model name, else instance name, else id). */
  name: string;
  /** Quant label, if known from a discovered model. */
  quant: string | null;
  /**
   * Repo/author this row groups under in the catalog (model's HF repo, else its
   * org). Null when neither is known (a bare local file or orphan profile).
   */
  repo: string | null;
  /** File size in bytes, if the model is discovered. */
  sizeBytes: number | null;
  /** The discovered model, if any. */
  model: Model | undefined;
  /**
   * Saved profiles launchable for this model, sorted by name. Empty when the
   * model has none (launching then uses config defaults).
   */
  profiles: InstanceConfig[];
  /**
   * Set only for a standalone row that *is* a single saved profile whose model
   * isn't discovered (an orphan). Undefined for ordinary model rows.
   */
  instance: InstanceConfig | undefined;
  /** The running child, if this model is up. */
  running: RunningModel | undefined;
  /** Per-instance stats, if running and sampled. */
  stats: InstanceStats | undefined;
  /** Whether the user has starred this row (floats it to the top). */
  isFavorite: boolean;
}

/**
 * Build the merged row list. Each discovered model gets one row carrying its
 * profiles; orphan profiles and orphan running children get standalone rows.
 * Running state and stats join onto the model id (the supervisor runs one child
 * per model). Deterministic ordering: running rows first (the ACTIVE INSTANCES
 * section), then favorites, then the rest clustered by repo. `favorites` is the
 * set of starred favorite ids (model or instance ids).
 */
export function buildRows(
  models: Model[],
  instances: InstanceConfig[],
  running: RunningModel[],
  stats: StatsSnapshot | null,
  favorites: ReadonlySet<string> = new Set(),
): Row[] {
  const modelById = new Map<string, Model>();
  for (const m of models) modelById.set(m.id, m);

  const runByModel = new Map<string, RunningModel>();
  for (const r of running) runByModel.set(r.modelId, r);

  const statsByModel = new Map<string, InstanceStats>();
  const statsByPid = new Map<number, InstanceStats>();
  if (stats) {
    for (const s of stats.instances) {
      statsByModel.set(s.modelId, s);
      statsByPid.set(s.pid, s);
    }
  }

  // Group every saved profile under the model it targets (exact id match).
  // Profiles whose selector resolves to no discovered model are orphans and get
  // their own standalone row so they stay reachable.
  const profilesByModel = new Map<string, InstanceConfig[]>();
  const orphanProfiles: InstanceConfig[] = [];
  for (const inst of instances) {
    const parent = modelById.get(inst.spec.model);
    if (parent) {
      const arr = profilesByModel.get(parent.id) ?? [];
      arr.push(inst);
      profilesByModel.set(parent.id, arr);
    } else {
      orphanProfiles.push(inst);
    }
  }
  const sortByName = (a: InstanceConfig, b: InstanceConfig): number =>
    a.name.localeCompare(b.name);

  // A favorite is tracked per group: starring a model (or any of its profiles)
  // floats the model's row up. A group is a favorite if its model id, or any of
  // its profiles' ids, is in the favorites set.
  const favoriteGroups = new Set<string>();
  for (const m of models) if (favorites.has(m.id)) favoriteGroups.add(m.id);
  for (const inst of instances) {
    const parent = modelById.get(inst.spec.model);
    const groupId = parent ? parent.id : inst.id;
    if (favorites.has(inst.id) || favorites.has(groupId))
      favoriteGroups.add(groupId);
  }

  const rows: Row[] = [];

  // One row per discovered model, carrying all of its launchable profiles.
  // Running/stats join here by model id (the supervisor runs one child per model).
  for (const m of models) {
    const run = runByModel.get(m.id);
    const stat =
      statsByModel.get(m.id) ?? (run ? statsByPid.get(run.pid) : undefined);
    rows.push({
      key: `m:${m.id}`,
      modelId: m.id,
      favoriteId: m.id,
      groupId: m.id,
      groupName: m.name,
      name: m.name,
      quant: m.quant ?? null,
      repo: m.repo ?? m.org,
      sizeBytes: m.sizeBytes ?? null,
      model: m,
      profiles: (profilesByModel.get(m.id) ?? []).slice().sort(sortByName),
      instance: undefined,
      running: run,
      stats: stat,
      isFavorite: favoriteGroups.has(m.id),
    });
  }

  // One standalone row per orphan profile (its model isn't discovered).
  for (const inst of orphanProfiles) {
    rows.push({
      key: `i:${inst.id}`,
      modelId: inst.id,
      favoriteId: inst.id,
      groupId: inst.id,
      groupName: inst.name,
      name: inst.name,
      quant: null,
      repo: null,
      sizeBytes: null,
      model: undefined,
      profiles: [inst],
      instance: inst,
      running: undefined,
      stats: undefined,
      isFavorite: favoriteGroups.has(inst.id),
    });
  }

  // Running children with neither a discovered model nor a profile still get a row.
  for (const r of running) {
    if (modelById.has(r.modelId)) continue;
    const stat = statsByModel.get(r.modelId) ?? statsByPid.get(r.pid);
    rows.push({
      key: `r:${r.modelId}`,
      modelId: r.modelId,
      favoriteId: r.modelId,
      groupId: r.modelId,
      groupName: r.name,
      name: r.name,
      quant: null,
      repo: null,
      sizeBytes: null,
      model: undefined,
      profiles: [],
      instance: undefined,
      running: r,
      stats: stat,
      isFavorite: favoriteGroups.has(r.modelId),
    });
  }

  // Ordering: running first, then favorites, then the rest clustered by repo.
  const rank = (r: Row): number => {
    if (r.running) return 0;
    if (r.isFavorite) return 1;
    return 2;
  };
  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Cluster by repo so the catalog renders one header per repo with its
    // variants beneath (rows without a repo sort last).
    const repoA = a.repo ?? "￿";
    const repoB = b.repo ?? "￿";
    if (repoA !== repoB) return repoA.localeCompare(repoB);
    if (a.groupName !== b.groupName) return a.groupName.localeCompare(b.groupName);
    if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Case-insensitive substring filter over the row's visible identity. */
export function filterRows(rows: Row[], filter: string): Row[] {
  const q = filter.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter((r) => {
    const profileHay = r.profiles.map((p) => `${p.name} ${p.id}`).join(" ");
    const hay = `${r.name} ${r.modelId} ${r.quant ?? ""} ${profileHay}`.toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Produce a sensible default LaunchSpec for a row when creating/editing a
 * profile for a model that has none yet. Seeds ctx and GPU layers from config
 * so a new profile reflects the GPU-by-default behavior.
 */
export function defaultSpecForRow(
  row: Row,
  defaultCtx: number,
  defaultGpuLayers: number,
): LaunchSpec {
  if (row.running) return row.running.spec;
  if (row.instance) return row.instance.spec;
  const selector = row.model?.id ?? row.modelId;
  return { model: selector, ctxSize: defaultCtx, gpuLayers: defaultGpuLayers };
}
