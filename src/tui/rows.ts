/**
 * Row-join logic shared by the table and the app's key handling. A row exists
 * for every discovered Model AND every saved InstanceConfig — a profile whose
 * model isn't (yet) discovered still appears. Each row is annotated with its
 * running state and per-instance stats so the presentational Table is dumb.
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
  /** Canonical model id this row keys on. */
  modelId: string;
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
  /** The running child, if this model is up. */
  running: RunningModel | undefined;
  /** Per-instance stats, if running and sampled. */
  stats: InstanceStats | undefined;
  /** Whether the user has starred this row (floats it to the top). */
  isFavorite: boolean;
}

/**
 * Build the merged row list keyed by model id. Deterministic ordering:
 * running rows first, then favorites, then rows with a saved instance, then
 * discovered-only, each group sorted by display name. `favorites` is the set
 * of starred row ids (model or instance ids).
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

  // Collect the set of keys: every model id and every instance's resolved model id.
  // An instance keys on its spec.model when that resolves to a discovered model
  // id; otherwise it keys on its own id so it still gets a distinct row.
  const order: string[] = [];
  const seen = new Set<string>();
  const instanceByKey = new Map<string, InstanceConfig>();

  const addKey = (key: string): void => {
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  };

  for (const m of models) addKey(m.id);

  for (const inst of instances) {
    // Prefer joining onto a discovered model when the selector matches an id.
    const key = modelById.has(inst.spec.model) ? inst.spec.model : inst.id;
    instanceByKey.set(key, inst);
    addKey(key);
  }

  // Running children that aren't a discovered model or instance still get a row.
  for (const r of running) addKey(r.modelId);

  const rows: Row[] = [];
  for (const key of order) {
    const model = modelById.get(key);
    const instance = instanceByKey.get(key);
    const run = runByModel.get(key);
    const stat =
      statsByModel.get(key) ?? (run ? statsByPid.get(run.pid) : undefined);

    const name =
      instance?.name ?? model?.name ?? run?.name ?? key;

    rows.push({
      modelId: key,
      name,
      quant: model?.quant ?? null,
      sizeBytes: model?.sizeBytes ?? null,
      model,
      instance,
      running: run,
      stats: stat,
      isFavorite: favorites.has(key),
    });
  }

  // Ordering: running rows first (the ACTIVE INSTANCES section), then within the
  // remaining catalog favorites float to the top, then saved profiles, then the
  // rest — each group sorted by display name.
  const rank = (r: Row): number => {
    if (r.running) return 0;
    if (r.isFavorite) return 1;
    if (r.instance) return 2;
    return 3;
  };
  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
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
