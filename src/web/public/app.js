/**
 * Entry point: wires the store to the header, toolbar and catalog, and installs
 * the keyboard shortcuts. The shortcuts deliberately match src/tui/HelpOverlay
 * so muscle memory carries between the two front ends; they act on the row the
 * pointer is over, since a web page has a cursor rather than a selection.
 */

import { el, fill, bytes, pct } from "./lib/dom.js";
import { api } from "./lib/api.js";
import { state, subscribe, startPolling, mutate, refreshNow } from "./lib/store.js";
import { renderCatalog, setFilter, visibleRows } from "./views/catalog.js";
import { openModal, closeModal, modalOpen } from "./views/modal.js";
import { openInfo } from "./views/info.js";
import { openLaunchPicker, openProfileManager, openNewProfile } from "./views/profiles.js";
import { openModelLog } from "./views/logs.js";
import { openChat } from "./views/chat.js";
import { openHfBrowser } from "./views/hf.js";
import { openDownloads } from "./views/downloads.js";
import { openInstalls, openBuildForm, activeBuilds } from "./views/installs.js";

const catalog = document.getElementById("catalog");
const meters = document.getElementById("meters");
const serverInfo = document.getElementById("server-info");
const errorBox = document.getElementById("error");
const filterInput = document.getElementById("filter");
const dlBadge = document.getElementById("dl-badge");
const buildBadge = document.getElementById("build-badge");

/* ------------------------------- header ---------------------------------- */

/** A labelled meter with a proportional bar; `hot` past 85%. */
function meter(label, text, fraction) {
  const node = el("span", { className: "meter" }, `${label} `, el("b", { textContent: text }));
  if (fraction !== undefined) {
    const bar = el("span", { className: `bar${fraction > 0.85 ? " hot" : ""}` },
      el("span", { style: { width: `${Math.min(100, Math.round(fraction * 100))}%` } }));
    node.append(bar);
  }
  return node;
}

function renderHeader() {
  const stats = state.stats;
  if (!stats) return;
  const sys = stats.system;
  const out = [
    meter("cpu", pct(sys.cpuPct), sys.cpuPct / 100),
    meter("ram", `${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}`, sys.memUsed / sys.memTotal),
  ];
  if (sys.tempC !== null) out.push(el("span", { className: "meter dim", textContent: `${Math.round(sys.tempC)}°C` }));
  for (const gpu of stats.gpus) {
    out.push(meter(`gpu${stats.gpus.length > 1 ? gpu.index : ""}`, pct(gpu.utilPct), gpu.utilPct / 100));
    out.push(
      meter("vram", `${bytes(gpu.vramUsed)} / ${bytes(gpu.vramTotal)}`, gpu.vramUsed / gpu.vramTotal),
    );
    if (gpu.tempC !== null) {
      out.push(el("span", { className: "meter dim", textContent: `${Math.round(gpu.tempC)}°C` }));
    }
  }
  fill(meters, out);

  const ls = state.llamaServer;
  fill(
    serverInfo,
    ls
      ? ls.found
        ? el("span", { className: "dim", textContent: `llama-server ${ls.version ?? "?"}` })
        : el("span", { className: "warn", textContent: "llama-server not found" })
      : null,
  );
}

function renderBadges() {
  const active = state.downloads.filter((d) => d.status === "downloading").length;
  dlBadge.hidden = active === 0;
  dlBadge.textContent = String(active);
  const builds = activeBuilds().length;
  buildBadge.hidden = builds === 0;
  buildBadge.textContent = String(builds);
}

function renderError() {
  errorBox.hidden = state.error === null;
  errorBox.textContent = state.error ?? "";
}

/* -------------------------------- help ----------------------------------- */

const BINDINGS = [
  ["Enter", "launch the hovered row — pick a profile when it has any"],
  ["s", "stop the hovered running instance"],
  ["i", "show full details about the hovered model"],
  ["f", "toggle favorite (★ — keeps the model at the top of the list)"],
  ["e", "manage profiles for the hovered model"],
  ["n", "create a new profile for the hovered model"],
  ["l", "view logs of the hovered running row"],
  ["c", "chat with the hovered running instance"],
  ["p", "pull a model from Hugging Face"],
  ["P", "manage downloads"],
  ["I", "view managed llama.cpp installs"],
  ["B", "build a managed llama.cpp install from source"],
  ["/", "focus the filter box"],
  ["?", "toggle this help"],
  ["Ctrl+R", "restart the daemon (stops all instances)"],
  ["Esc", "close a dialog / clear the filter"],
];

function openHelp() {
  const grid = el("div", { className: "help-grid" });
  for (const [keys, desc] of BINDINGS) {
    grid.append(el("div", { className: "k", textContent: keys }), el("div", { textContent: desc }));
  }
  openModal({
    title: "Keyboard shortcuts",
    subtitle: "shortcuts act on the row under the pointer",
    body: grid,
    footer: [
      el("button", {
        textContent: "Restart daemon",
        title: "stops all instances, then respawns the daemon",
        onclick: () => {
          if (!window.confirm("Restart the daemon? This stops every running instance.")) return;
          closeModal();
          void mutate(() => api.restartDaemon());
        },
      }),
      el("button", { className: "primary", textContent: "Close", onclick: closeModal }),
    ],
  });
}

/* ------------------------------ shortcuts -------------------------------- */

/** The row the pointer is over, so shortcuts have a target. */
let hoveredKey = null;

catalog.addEventListener("mouseover", (e) => {
  const rowNode = e.target.closest(".row");
  hoveredKey = rowNode?.dataset.key ?? null;
});
catalog.addEventListener("mouseleave", () => {
  hoveredKey = null;
});

function hoveredRow() {
  if (hoveredKey === null) return undefined;
  return visibleRows().find((r) => r.key === hoveredKey);
}

document.addEventListener("keydown", (e) => {
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement;

  if (e.key === "Escape") {
    if (modalOpen()) closeModal();
    else if (document.activeElement === filterInput) {
      filterInput.value = "";
      applyFilter();
      filterInput.blur();
    }
    return;
  }

  // While typing or with a dialog up, only Escape (handled above) applies.
  if (typing || modalOpen()) return;

  if (e.key === "/") {
    e.preventDefault();
    filterInput.focus();
    return;
  }
  if (e.key === "?") {
    openHelp();
    return;
  }
  if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    if (window.confirm("Restart the daemon? This stops every running instance.")) {
      void mutate(() => api.restartDaemon());
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "p":
      openHfBrowser();
      return;
    case "P":
      openDownloads();
      return;
    case "I":
      openInstalls();
      return;
    case "B":
      openBuildForm();
      return;
  }

  const row = hoveredRow();
  if (!row) return;

  switch (e.key) {
    case "Enter":
      if (row.running) return;
      if (row.profiles.length > 0) openLaunchPicker(row);
      else void mutate(() => api.start({ model: row.modelId }));
      break;
    case "s":
      if (row.running) void mutate(() => api.stop(row.modelId));
      break;
    case "i":
      openInfo(row);
      break;
    case "f":
      void mutate(() => api.toggleFavorite(row.favoriteId));
      break;
    case "e":
      openProfileManager(row);
      break;
    case "n":
      openNewProfile(row);
      break;
    case "l":
      if (row.running) openModelLog(row);
      break;
    case "c":
      if (row.running) openChat(row);
      break;
    default:
      break;
  }
});

/* -------------------------------- toolbar -------------------------------- */

function applyFilter() {
  setFilter(filterInput.value);
  renderCatalog(catalog);
}

filterInput.addEventListener("input", applyFilter);

for (const button of document.querySelectorAll("nav button[data-open]")) {
  button.addEventListener("click", () => {
    ({
      hf: openHfBrowser,
      downloads: openDownloads,
      installs: openInstalls,
      help: openHelp,
    })[button.dataset.open]();
  });
}

/* --------------------------------- boot ---------------------------------- */

subscribe(() => {
  renderHeader();
  renderBadges();
  renderError();
  // Re-rendering the catalog under an open dialog would be wasted work and can
  // steal focus; the dialog refreshes itself through its own subscription.
  if (!modalOpen()) renderCatalog(catalog);
});

startPolling();
void refreshNow();
