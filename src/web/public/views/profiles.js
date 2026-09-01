/**
 * Launch picker and profile manager — the two dialogs behind the TUI's Enter
 * and `e`. A model row carries all of its saved profiles (profiles are not rows
 * of their own), so both dialogs work from `row.profiles`.
 */

import { defaultSpecForRow } from "/mod/tui/rows.js";
import { el, bytes } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { mutate } from "../lib/store.js";
import { openModal, closeModal } from "./modal.js";
import { openFlagEditor } from "./flags.js";
import { specLines } from "./info.js";

/**
 * Defaults for a fresh spec. The daemon applies its own config defaults on
 * launch; these mirror them (ctx 4096, all layers on GPU) so the editor shows
 * what will actually happen rather than a misleading blank.
 */
const DEFAULT_CTX = 4096;
const DEFAULT_NGL = 99;

function seedSpec(row) {
  return defaultSpecForRow(row, DEFAULT_CTX, DEFAULT_NGL);
}

/** A profile's flags, rendered compactly under its name. */
function specPreview(spec) {
  return el(
    "div",
    { className: "dim" },
    ...specLines(spec).map((l) => el("div", { textContent: `  ${l}` })),
  );
}

/** The TUI's Enter: launch with the defaults, a saved profile, or a new one. */
export function openLaunchPicker(row) {
  const body = el("div", {});

  body.append(
    el(
      "div",
      { className: "row" },
      el("span", { className: "name" }, "Default", el("span", { className: "dim" }, " — config defaults, nothing saved")),
      el("button", {
        className: "primary",
        textContent: "launch",
        onclick: () => {
          closeModal();
          void mutate(() => api.start({ model: row.modelId }));
        },
      }),
    ),
  );

  for (const p of row.profiles) {
    body.append(
      el(
        "div",
        { className: "row" },
        el("span", { className: "name" }, p.name),
        el("button", {
          textContent: "launch",
          onclick: () => {
            closeModal();
            void mutate(() => api.start({ instance: p.id }));
          },
        }),
      ),
      specPreview(p.spec),
    );
  }

  openModal({
    title: `Launch ${row.name}`,
    subtitle: row.sizeBytes !== null ? bytes(row.sizeBytes) : "",
    body,
    footer: [
      el("button", { textContent: "+ New profile", onclick: () => openNewProfile(row) }),
      el("button", { textContent: "Close", onclick: closeModal }),
    ],
  });
}

/** Create a profile for this row, then save it. */
export function openNewProfile(row) {
  openFlagEditor({
    title: `New profile · ${row.name}`,
    spec: seedSpec(row),
    name: "",
    model: row.model,
    submitLabel: "Create",
    onSubmit: (spec, name) => {
      closeModal();
      void mutate(() => api.createInstance(undefined, name ?? row.name, spec));
    },
  });
}

/** Edit an existing profile. */
export function openEditProfile(row, profile) {
  openFlagEditor({
    title: `Edit profile · ${profile.name}`,
    spec: profile.spec,
    name: profile.name,
    model: row.model,
    submitLabel: "Save",
    onSubmit: (spec, name) => {
      closeModal();
      void mutate(() => api.updateInstance(profile.id, { name: name ?? profile.name, spec }));
    },
  });
}

/**
 * Launch this model once with edited flags, without saving a profile. The
 * control plane accepts an inline spec on /start, so nothing is persisted.
 */
export function openLaunchWithFlags(row) {
  openFlagEditor({
    title: `Launch ${row.name} with flags`,
    spec: seedSpec(row),
    model: row.model,
    showName: false,
    submitLabel: "Launch",
    onSubmit: (spec) => {
      closeModal();
      void mutate(() => api.start({ spec }));
    },
  });
}

/** The TUI's `e`: switch / create / edit / delete this model's profiles. */
export function openProfileManager(row) {
  const body = el("div", {});

  if (row.profiles.length === 0) {
    body.append(el("div", { className: "dim", textContent: "(no saved profiles yet)" }));
  }

  for (const p of row.profiles) {
    body.append(
      el(
        "div",
        { className: "row" },
        el("span", { className: "name" }, p.name),
        el("button", {
          className: "primary",
          textContent: "launch",
          onclick: () => {
            closeModal();
            void mutate(() => api.start({ instance: p.id }));
          },
        }),
        el("button", { textContent: "edit", onclick: () => openEditProfile(row, p) }),
        el("button", {
          className: "danger",
          textContent: "delete",
          onclick: () => {
            if (!window.confirm(`Delete profile "${p.name}"?`)) return;
            closeModal();
            void mutate(() => api.removeInstance(p.id));
          },
        }),
      ),
      specPreview(p.spec),
    );
  }

  openModal({
    title: `Profiles · ${row.name}`,
    body,
    footer: [
      el("button", { textContent: "Launch with flags…", onclick: () => openLaunchWithFlags(row) }),
      el("button", { textContent: "+ New profile", onclick: () => openNewProfile(row) }),
      el("button", { textContent: "Close", onclick: closeModal }),
    ],
  });
}
