/**
 * The polling store — the web counterpart of src/tui/useDaemon.ts, with the
 * same split: one interval fetches the fast-changing data (/ps, /stats,
 * /downloads, /installs), while the slower lists (/models, /instances,
 * /favorites, /llama/flags) are fetched on load and after every mutation.
 *
 * Errors never throw out of here; they land in `state.error` so a transient
 * daemon hiccup dims the page instead of breaking it.
 */

import { api } from "./api.js";

const POLL_MS = 1500;

export const state = {
  models: [],
  instances: [],
  favorites: [],
  running: [],
  stats: null,
  llamaServer: null,
  llamaSpec: null,
  downloads: [],
  installs: null,
  error: null,
  loaded: false,
};

const listeners = new Set();

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

function fail(e) {
  state.error = e instanceof Error ? e.message : String(e);
  emit();
}

/** Fetch the rarely-changing lists. */
export async function refreshStatic() {
  try {
    const [models, instances, favorites] = await Promise.all([
      api.models(),
      api.instances(),
      api.favorites(),
    ]);
    state.models = models.models;
    state.instances = instances.instances;
    state.favorites = favorites.favorites;
    // Isolated and best-effort, as in the TUI: an older daemon without this
    // route, or a failed --help probe, must not break the lists above. The flag
    // editor falls back to its curated fields when llamaSpec stays null.
    try {
      state.llamaSpec = (await api.llamaFlags()).spec;
    } catch {
      /* keep whatever we had */
    }
    state.error = null;
    emit();
  } catch (e) {
    fail(e);
  }
}

/** Fetch the fast-changing data. */
export async function refreshDynamic() {
  try {
    const [ps, stats, downloads, installs] = await Promise.all([
      api.ps(),
      api.stats(),
      api.downloads(),
      api.installs(),
    ]);
    state.running = ps.running;
    state.stats = stats.stats;
    state.llamaServer = stats.llamaServer;
    state.downloads = downloads.downloads;
    state.installs = installs;
    state.error = null;
    state.loaded = true;
    emit();
    // While downloads are in flight, keep the catalog fresh so a finished one
    // shows up promptly (the daemon re-discovers on completion).
    if (downloads.downloads.length > 0) void refreshStatic();
  } catch (e) {
    fail(e);
  }
}

/** Refresh everything — used after a mutation. */
export async function refreshNow() {
  await Promise.all([refreshStatic(), refreshDynamic()]);
}

/**
 * Run a mutation, then refresh. Surfaces failures in `state.error` rather than
 * rejecting, so callers can stay `void`-style like the TUI's runMutation.
 */
export async function mutate(fn) {
  try {
    await fn();
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  await refreshNow();
}

/** Start the poll loop. */
export function startPolling() {
  void (async () => {
    await refreshStatic();
    await refreshDynamic();
    setInterval(() => void refreshDynamic(), POLL_MS);
  })();
}

/** The favorites list as a Set, which is what buildRows expects. */
export function favoriteSet() {
  return new Set(state.favorites);
}

/** True when the host has a usable GPU (drives the memory estimate). */
export function gpuAvailable() {
  return state.stats?.gpuAvailable ?? false;
}
