/**
 * The single modal host. One dialog is open at a time (as in the TUI, where
 * `mode` is one value), Esc closes it, and a click on the backdrop closes it
 * unless the dialog opted out. Views call `openModal` and get a handle they can
 * use to close themselves or swap their own body.
 */

import { el, fill } from "../lib/dom.js";

let backdrop;
let container;
/** Cleanup for the dialog currently on screen (intervals, abort controllers). */
let activeCleanup = null;

function ensureMounted() {
  if (backdrop) return;
  backdrop = document.getElementById("modal-backdrop");
  container = document.getElementById("modal");
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeModal();
  });
}

/** True when a dialog is on screen (app.js checks before handling shortcuts). */
export function modalOpen() {
  return Boolean(backdrop) && !backdrop.hidden;
}

export function closeModal() {
  if (!modalOpen()) return;
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  backdrop.hidden = true;
  fill(container);
}

/**
 * Show a dialog. `footer` is an array of buttons; `onClose` runs on dismissal.
 * Returns `{ close, setBody, setSubtitle }` for dialogs that update in place.
 */
export function openModal({ title, subtitle, subtitleHref, body, footer, onClose, width }) {
  ensureMounted();
  closeModal();
  activeCleanup = onClose ?? null;
  // Dialogs that read better narrow (the field list) can say so; the rest get
  // the stylesheet's default width.
  container.style.width = width ?? "";

  const subtitleNode = subtitleHref
    ? el("a", {
        className: "sub",
        href: subtitleHref,
        target: "_blank",
        rel: "noreferrer",
        textContent: subtitle ?? "",
      })
    : el("span", { className: "sub", textContent: subtitle ?? "" });

  const bodyNode = el("div", { className: "modal-body" }, body);

  fill(
    container,
    el(
      "div",
      { className: "modal-head" },
      el("h2", { textContent: title }),
      subtitleNode,
      el("button", { textContent: "✕", title: "close (Esc)", onclick: closeModal }),
    ),
    bodyNode,
    footer?.length ? el("div", { className: "modal-foot" }, ...footer) : null,
  );

  backdrop.hidden = false;
  // Focus the first control so the dialog is keyboard-usable immediately.
  const first = container.querySelector("input, select, textarea, button.primary");
  if (first) first.focus();

  return {
    close: closeModal,
    setBody: (...children) => fill(bodyNode, ...children),
    setSubtitle: (text) => {
      subtitleNode.textContent = text;
    },
  };
}
