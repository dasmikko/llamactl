/**
 * Row-join logic shared by the table and the app's key handling. A discovered
 * Model gets a base row. A model's *inline* config — the profile whose id equals
 * the model id (the one `e` edits) — merges into that base row, so editing a
 * model's flags stays on one line. Any *additional* profiles (created with `n`,
 * for testing variants) each get their own indented row grouped directly beneath
 * the model (a profile whose model isn't discovered still appears as its own
 * row). Each row is annotated with its running state and per-instance stats so
 * the presentational Table is dumb.
 */

import type {
  Model,
  InstanceConfig,
  RunningModel,
  StatsSnapshot,
  InstanceStats,
  LaunchSpec,
} from "../types.ts";

/** A merged, display-ready row. */
export interface Row {
  /**
   * Unique, stable React/selection key for this row. Distinct from `modelId`
   * because a model and its profiles share a model id but are separate rows.
   */
  key: string;
  /** Canonical model id this row keys on (for running/stop/stats joins). */
  modelId: string;
  /** Id used in the favorites set for this row (model id or instance id). */
  favoriteId: string;
  /** Sort group: the parent model's id, so profiles cluster under it. */
  groupId: string;
  /** Sort group label: the parent model's display name. */
  groupName: string;
  /** Display name (instance name preferred, else model name, else id). */
  name: string;
  /** Quant label, if known from a discovered model. */
  quant: string | null;
  /** File size in bytes, if the model is discovered. */
  sizeBytes: number | null;
  /** The discovered model, if any. */
  model: Model | undefined;
  /** The saved instance profile, if this row corresponds to one. */
  instance: InstanceConfig | undefined;
  /**
   * True for an *additional* profile row (one of a model's testing variants),
   * which renders indented under its model. False for a base model row even
   * when it carries an inline profile.
   */
  isExtraProfile: boolean;
  /** The running child, if this model is up. */
  running: RunningModel | undefined;
  /** Per-instance stats, if running and sampled. */
  stats: InstanceStats | undefined;
  /** Whether the user has starred this row (floats it to the top). */
  isFavorite: boolean;
}

/**
 * Build the merged row list. Each discovered model gets a base row, and every
 * saved profile gets its own row grouped beneath the model it targets. Running
 * state and stats join onto the model id (the supervisor runs one child per
 * model). Deterministic ordering: running rows first (the ACTIVE INSTANCES
 * section), then favorites, then the rest grouped so a model's profiles sit
 * directly under it. `favorites` is the set of starred favorite ids (model or
 * instance ids).
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

  // Split saved profiles into each model's inline config (id === model id, the
  // one merged onto the model's row) and the additional profiles (everything
  // else, rendered as indented child rows).
  const inlineByModel = new Map<string, InstanceConfig>();
  const extras: InstanceConfig[] = [];
  for (const inst of instances) {
    const parent = modelById.get(inst.spec.model);
    if (parent && inst.id === parent.id) inlineByModel.set(parent.id, inst);
    else extras.push(inst);
  }

  const rows: Row[] = [];

  // One base row per discovered model, carrying its inline config (if any).
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
      sizeBytes: m.sizeBytes ?? null,
      model: m,
      instance: inlineByModel.get(m.id),
      isExtraProfile: false,
      running: run,
      stats: stat,
      isFavorite: favorites.has(m.id),
    });
  }

  // One indented child row per additional profile, grouped under its model when
  // the selector resolves to a discovered model; otherwise it stands alone.
  for (const inst of extras) {
    const parent = modelById.get(inst.spec.model);
    rows.push({
      key: `i:${inst.id}`,
      modelId: parent ? parent.id : inst.id,
      favoriteId: inst.id,
      groupId: parent ? parent.id : inst.id,
      groupName: parent ? parent.name : inst.name,
      name: inst.name,
      quant: parent?.quant ?? null,
      sizeBytes: parent?.sizeBytes ?? null,
      model: parent,
      instance: inst,
      isExtraProfile: true,
      running: undefined,
      stats: undefined,
      isFavorite: favorites.has(inst.id),
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
      sizeBytes: null,
      model: undefined,
      instance: undefined,
      isExtraProfile: false,
      running: r,
      stats: stat,
      isFavorite: favorites.has(r.modelId),
    });
  }

  // Ordering: running first, then favorites, then the rest grouped so each
  // model's profiles sit directly beneath its base row (base before profiles,
  // profiles by name). groupId is the tiebreak when two groups share a name.
  const rank = (r: Row): number => {
    if (r.running) return 0;
    if (r.isFavorite) return 1;
    return 2;
  };
  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.groupName !== b.groupName) return a.groupName.localeCompare(b.groupName);
    if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
    const sa = a.isExtraProfile ? 1 : 0;
    const sb = b.isExtraProfile ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Case-insensitive substring filter over the row's visible identity. */
export function filterRows(rows: Row[], filter: string): Row[] {
  const q = filter.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter((r) => {
    const hay = `${r.name} ${r.modelId} ${r.quant ?? ""} ${
      r.instance?.id ?? ""
    }`.toLowerCase();
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
