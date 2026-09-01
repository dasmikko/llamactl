/**
 * The model list: the same three sections the TUI shows — ACTIVE INSTANCES,
 * ★ FAVORITES, then the MODELS catalog grouped by Hugging Face repo. Rows come
 * from the TUI's own `buildRows`/`filterRows` (served transpiled from
 * src/tui/rows.ts), so the join, ordering and grouping rules can't drift.
 */

import { buildRows, filterRows } from "/mod/tui/rows.js";
import { el, fill, bytes, uptime, pct } from "../lib/dom.js";
import { state, favoriteSet, mutate } from "../lib/store.js";
import { api } from "../lib/api.js";
import { openInfo } from "./info.js";
import { openLaunchPicker, openProfileManager, openNewProfile } from "./profiles.js";
import { openModelLog } from "./logs.js";
import { openChat } from "./chat.js";

/** Current filter text, owned by the toolbar input in app.js. */
let filter = "";

export function setFilter(text) {
  filter = text;
}

/** The rows the catalog is currently showing, in display order. */
export function visibleRows() {
  const rows = buildRows(
    state.models,
    state.instances,
    state.running,
    state.stats,
    favoriteSet(),
  );
  return filterRows(rows, filter);
}

/** Find a row by its key among the visible ones (used after a state refresh). */
export function findRow(key) {
  return visibleRows().find((r) => r.key === key);
}

function confirmThen(message, fn) {
  if (window.confirm(message)) void fn();
}

/** One row's action buttons, mirroring the TUI's per-row keybindings. */
function actions(row) {
  const out = [];
  const running = row.running;

  if (running) {
    out.push(
      el("button", {
        textContent: "stop",
        onclick: () => void mutate(() => api.stop(row.modelId)),
      }),
      el("button", { textContent: "chat", onclick: () => openChat(row) }),
      el("button", { textContent: "logs", onclick: () => openModelLog(row) }),
      // The child serves its own web UI; only reachable when the browser is on
      // the same host, which is the common case for a loopback bind.
      el(
        "a",
        {
          href: `http://${running.spec.host ?? "127.0.0.1"}:${running.port}`,
          target: "_blank",
          rel: "noreferrer",
          title: "open this instance's own web UI",
        },
        el("button", { textContent: "open" }),
      ),
    );
  } else {
    out.push(
      el("button", {
        className: "primary",
        textContent: row.profiles.length > 0 ? "start ▾" : "start",
        title:
          row.profiles.length > 0
            ? "choose a profile to launch with"
            : "launch with the default flags",
        // With saved profiles there's a choice to make, so open the picker (the
        // TUI's Enter); with none there is nothing to pick, so launch directly.
        onclick: () =>
          row.profiles.length > 0
            ? openLaunchPicker(row)
            : void mutate(() => api.start({ model: row.modelId })),
      }),
    );
  }

  out.push(
    el("button", {
      textContent: row.profiles.length > 0 ? `profiles (${row.profiles.length})` : "+ profile",
      onclick: () => (row.profiles.length > 0 ? openProfileManager(row) : openNewProfile(row)),
    }),
    el("button", { textContent: "info", onclick: () => openInfo(row) }),
  );

  // An orphan profile row is deletable as a profile; a real model row deletes
  // its file(s) from disk, which the daemon refuses while it is running.
  if (row.instance) {
    out.push(
      el("button", {
        className: "danger",
        textContent: "delete",
        title: "delete this saved profile",
        onclick: () =>
          confirmThen(`Delete profile "${row.instance.name}"?`, () =>
            mutate(() => api.removeInstance(row.instance.id)),
          ),
      }),
    );
  } else if (row.model) {
    out.push(
      el("button", {
        className: "danger",
        textContent: "delete",
        title: running ? "stop the instance first" : "delete the model file(s) from disk",
        disabled: Boolean(running),
        onclick: () =>
          confirmThen(
            `Delete ${row.name} from disk?\n\n${row.model.path}\n\nThis cannot be undone.`,
            () => mutate(() => api.deleteModel(row.model.id)),
          ),
      }),
    );
  }

  return el("div", { className: "actions" }, ...out);
}

/** Render a single row. */
function renderRow(row, { indent = false } = {}) {
  const running = row.running;
  const stats = row.stats;

  const name = el("span", { className: "name" }, row.name);
  if (running?.warnings?.length) {
    name.append(
      " ",
      el("span", {
        className: "warn",
        textContent: `⚠ ${running.warnings.length}`,
        title: running.warnings.join("\n"),
      }),
    );
  }

  const meta = [];
  if (running) {
    meta.push(el("span", { className: `status-${running.status}`, textContent: running.status }));
    meta.push(el("span", { className: "meta", textContent: `:${running.port}` }));
    if (stats) {
      meta.push(
        el("span", {
          className: "meta",
          textContent: `${pct(stats.cpuPct)} · ${bytes(stats.rssBytes)}${
            stats.vramBytes ? ` · ${bytes(stats.vramBytes)} vram` : ""
          }`,
        }),
      );
    }
    meta.push(el("span", { className: "meta", textContent: uptime(running.startedAt) }));
  } else {
    if (row.quant) meta.push(el("span", { className: "tag", textContent: row.quant }));
    if (row.sizeBytes !== null) {
      meta.push(el("span", { className: "meta", textContent: bytes(row.sizeBytes) }));
    }
    if (row.model?.contextLength) {
      meta.push(
        el("span", { className: "meta", textContent: `${Math.round(row.model.contextLength / 1024)}K ctx` }),
      );
    }
    if (row.instance) meta.push(el("span", { className: "tag", textContent: "profile" }));
  }

  return el(
    "div",
    {
      className: `row${indent ? " indent" : ""}${running ? " is-running" : ""}`,
      // Stamped so app.js can resolve the row under the pointer for shortcuts.
      dataset: { key: row.key },
    },
    el("button", {
      className: `star${row.isFavorite ? " on" : ""}`,
      textContent: row.isFavorite ? "★" : "☆",
      title: "toggle favorite",
      onclick: () => void mutate(() => api.toggleFavorite(row.favoriteId)),
    }),
    name,
    ...meta,
    actions(row),
  );
}

function sectionTitle(text, extra) {
  return el("div", { className: "section-title" }, text, extra ? el("span", { className: "dim" }, ` ${extra}`) : null);
}

/** Render the whole catalog into `container`. */
export function renderCatalog(container) {
  const rows = visibleRows();
  const running = rows.filter((r) => r.running);
  const favorites = rows.filter((r) => !r.running && r.isFavorite);
  const rest = rows.filter((r) => !r.running && !r.isFavorite);

  const out = [];

  out.push(sectionTitle("Active instances", running.length ? `(${running.length})` : ""));
  if (running.length === 0) {
    out.push(el("div", { className: "empty", textContent: "(none running)" }));
  } else {
    out.push(...running.map((r) => renderRow(r)));
  }

  if (favorites.length > 0) {
    out.push(sectionTitle("★ Favorites"));
    out.push(...favorites.map((r) => renderRow(r)));
  }

  out.push(sectionTitle("Models", `(${rest.length})`));
  if (rest.length === 0) {
    out.push(
      el("div", {
        className: "empty",
        textContent: state.loaded ? "(no models or profiles match)" : "loading…",
      }),
    );
  } else {
    // Grouped by repo, one header per repo, variants indented — as the TUI's
    // `grouped` catalog table renders it. Rows already arrive repo-clustered.
    let currentRepo;
    for (const row of rest) {
      if (row.repo !== currentRepo) {
        currentRepo = row.repo;
        out.push(
          el(
            "div",
            { className: "repo-header" },
            currentRepo
              ? el("a", {
                  href: `https://huggingface.co/${currentRepo}`,
                  target: "_blank",
                  rel: "noreferrer",
                  textContent: currentRepo,
                })
              : el("span", { className: "dim", textContent: "(local files)" }),
          ),
        );
      }
      out.push(renderRow(row, { indent: true }));
    }
  }

  fill(container, out);
}
