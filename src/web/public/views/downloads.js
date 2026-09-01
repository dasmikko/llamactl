/**
 * Downloads panel — the TUI's `P`. Live progress for the daemon's background
 * downloads, with the same three actions: retry/resume an errored or canceled
 * one, cancel an in-flight one, dismiss a finished one.
 */

import { el, bytes } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state, subscribe, refreshDynamic } from "../lib/store.js";
import { openModal } from "./modal.js";

/** Percentage complete, or null when the server didn't send a length. */
function progress(dl) {
  if (!dl.totalBytes) return null;
  return Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100));
}

/** One row; also used inline by the header badge summary. */
function downloadRow(dl) {
  const pctValue = progress(dl);
  const bar = el(
    "div",
    { className: `progress ${dl.status === "error" ? "error" : dl.status === "done" ? "done" : ""}` },
    el("span", { style: { width: `${pctValue ?? (dl.status === "done" ? 100 : 0)}%` } }),
  );

  const actions = [];
  if (dl.status === "downloading") {
    actions.push(
      el("button", {
        textContent: "cancel",
        onclick: () => void api.cancelDownload(dl.id).then(refreshDynamic),
      }),
    );
  } else {
    if (dl.status === "error" || dl.status === "canceled") {
      actions.push(
        el("button", {
          textContent: "retry",
          title: "resume from the partial file",
          onclick: () => void api.retryDownload(dl.id).then(refreshDynamic),
        }),
      );
    }
    actions.push(
      el("button", {
        textContent: "dismiss",
        onclick: () => void api.dismissDownload(dl.id).then(refreshDynamic),
      }),
    );
  }

  return el(
    "div",
    { className: "row" },
    el(
      "span",
      { className: "name" },
      el("div", { textContent: dl.file }),
      el("div", { className: "dim", textContent: dl.repo }),
    ),
    bar,
    el("span", {
      className: dl.status === "error" ? "warn" : "meta",
      textContent:
        dl.status === "error"
          ? (dl.error ?? "error")
          : dl.status === "downloading"
            ? `${bytes(dl.receivedBytes)}${dl.totalBytes ? ` / ${bytes(dl.totalBytes)}` : ""}${
                pctValue === null ? "" : ` (${pctValue}%)`
              }`
            : dl.status,
    }),
    el("div", { className: "actions" }, ...actions),
  );
}

export function openDownloads() {
  const body = el("div", {});

  function render() {
    if (state.downloads.length === 0) {
      body.replaceChildren(el("div", { className: "dim", textContent: "(no downloads)" }));
      return;
    }
    body.replaceChildren(...state.downloads.map(downloadRow));
  }

  render();
  // Re-render on every poll so progress bars move while the dialog is open.
  const unsubscribe = subscribe(render);
  openModal({
    title: "Downloads",
    subtitle: "finished entries clear themselves after a grace period",
    body,
    onClose: unsubscribe,
  });
}
