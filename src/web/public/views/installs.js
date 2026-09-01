/**
 * Managed llama.cpp installs — the TUI's `I` and `B`. Lists the builds llamactl
 * has compiled, which one is active (the binary the supervisor spawns), plus
 * in-flight builds with live progress. Building from source is the same
 * BuildRequest the CLI's `install` command sends.
 */

import { el, bytes, uptime } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state, subscribe, mutate, refreshDynamic } from "../lib/store.js";
import { openModal, closeModal } from "./modal.js";
import { openBuildLog } from "./logs.js";

/** Build phases that are still in progress (anything but a terminal state). */
const ACTIVE_BUILD = new Set([
  "queued",
  "cloning",
  "fetching",
  "configuring",
  "building",
  "installing",
]);

export function activeBuilds() {
  return (state.installs?.builds ?? []).filter((b) => ACTIVE_BUILD.has(b.status));
}

function installRow(install, activeId) {
  const isActive = install.id === activeId;
  return el(
    "div",
    { className: "row" },
    el(
      "span",
      { className: "name" },
      install.name,
      isActive ? el("span", { className: "tag", textContent: "active" }) : null,
      el("div", {
        className: "dim",
        textContent: `${install.backend} · ${install.ref}${
          install.commit ? ` @ ${install.commit.slice(0, 8)}` : ""
        } · ${install.version ?? "unknown version"}`,
      }),
    ),
    el("span", {
      className: "meta",
      textContent: install.sizeBytes ? bytes(install.sizeBytes) : "",
    }),
    el(
      "div",
      { className: "actions" },
      el("button", {
        className: isActive ? "on" : "",
        textContent: isActive ? "in use" : "use",
        disabled: isActive,
        title: "make this the binary the daemon spawns",
        onclick: () => void mutate(() => api.setActiveInstall(install.id)),
      }),
      el("button", {
        textContent: "update",
        title: "fetch the latest code for this ref and recompile",
        onclick: () => void mutate(() => api.updateInstall(install.id)),
      }),
      el("button", {
        textContent: "rename",
        onclick: () => {
          const name = window.prompt(`Rename "${install.name}" to:`, install.name);
          if (name) void mutate(() => api.renameInstall(install.id, name));
        },
      }),
      el("button", {
        className: "danger",
        textContent: "remove",
        onclick: () => {
          if (!window.confirm(`Remove install "${install.name}" and its files?`)) return;
          void mutate(() => api.removeInstall(install.id));
        },
      }),
    ),
  );
}

function buildRow(build) {
  const running = ACTIVE_BUILD.has(build.status);
  return el(
    "div",
    {},
    el(
      "div",
      { className: "row" },
      el(
        "span",
        { className: "name" },
        build.name ?? build.id,
        el("div", { className: "dim", textContent: `${build.repo} · ${build.ref ?? "default"}` }),
      ),
      el("span", {
        className: build.status === "error" ? "warn" : "meta",
        textContent: build.status,
      }),
      el("span", {
        className: "meta",
        textContent: build.startedAt ? uptime(build.startedAt) : "",
      }),
      el(
        "div",
        { className: "actions" },
        el("button", { textContent: "log", onclick: () => openBuildLog(build) }),
        running
          ? el("button", {
              textContent: "cancel",
              onclick: () => void mutate(() => api.cancelBuild(build.id)),
            })
          : el("button", {
              className: "danger",
              textContent: "clear",
              title: "remove this failed/finished build entry",
              onclick: () => void mutate(() => api.removeInstall(build.id)),
            }),
      ),
    ),
    build.error ? el("div", { className: "warn", textContent: build.error }) : null,
    // The tail rides along in the /installs payload, so live progress needs no
    // extra request — the full log is behind the "log" button.
    build.logTail?.length
      ? el("div", { className: "dim", textContent: build.logTail.at(-1) })
      : null,
  );
}

/** The build form — the TUI's `B`. */
export function openBuildForm() {
  const repo = el("input", { type: "text", placeholder: "https://github.com/ggml-org/llama.cpp" });
  const ref = el("input", { type: "text", placeholder: "master, a tag, a sha, or pr/1234" });
  const name = el("input", { type: "text", placeholder: "derived from repo + ref" });
  const backend = el(
    "select",
    {},
    el("option", { value: "cuda", textContent: "cuda", selected: true }),
    el("option", { value: "cpu", textContent: "cpu" }),
  );
  const allowUnsupported = el("input", { type: "checkbox" });
  const hostCompiler = el("input", { type: "text", placeholder: "g++-15" });

  const body = el(
    "div",
    {},
    el("div", { className: "field" }, el("label", { textContent: "Repo" }), repo,
      el("span", { className: "help", textContent: "blank ⇒ upstream llama.cpp" })),
    el("div", { className: "field" }, el("label", { textContent: "Git ref" }), ref,
      el("span", { className: "help", textContent: "blank ⇒ default branch" })),
    el("div", { className: "field" }, el("label", { textContent: "Backend" }), backend),
    el("div", { className: "field" }, el("label", { textContent: "Name" }), name),
    el("div", { className: "field" }, el("label", { textContent: "CUDA host compiler" }), hostCompiler,
      el("span", { className: "help", textContent: "-DCMAKE_CUDA_HOST_COMPILER, when gcc is too new" })),
    el("div", { className: "field" }, el("label", { textContent: "Allow unsupported compiler" }), allowUnsupported,
      el("span", { className: "help", textContent: "passes -allow-unsupported-compiler to nvcc" })),
    el("div", { className: "dim", textContent: "Builds run in the background; watch progress under Installs." }),
  );

  openModal({
    title: "Build llama.cpp from source",
    body,
    footer: [
      el("button", { textContent: "Cancel", onclick: closeModal }),
      el("button", {
        className: "primary",
        textContent: "Build",
        onclick: () => {
          const req = { repo: repo.value.trim(), backend: backend.value };
          if (ref.value.trim()) req.ref = ref.value.trim();
          if (name.value.trim()) req.name = name.value.trim();
          if (hostCompiler.value.trim()) req.cudaHostCompiler = hostCompiler.value.trim();
          if (allowUnsupported.checked) req.allowUnsupportedCompiler = true;
          closeModal();
          void mutate(() => api.startBuild(req)).then(openInstalls);
        },
      }),
    ],
  });
}

export function openInstalls() {
  const body = el("div", {});

  function render() {
    const data = state.installs;
    const out = [];
    if (!data) {
      body.replaceChildren(el("div", { className: "dim", textContent: "loading…" }));
      return;
    }

    out.push(el("div", { className: "section-title", textContent: "Installed" }));
    if (data.installs.length === 0) {
      out.push(
        el("div", {
          className: "dim",
          textContent: "(none — the daemon uses llama-server from PATH)",
        }),
      );
    } else {
      out.push(...data.installs.map((i) => installRow(i, data.activeId)));
      out.push(
        el(
          "div",
          { className: "row" },
          el("span", { className: "name dim" }, "PATH binary"),
          el("button", {
            className: data.activeId === null ? "on" : "",
            textContent: data.activeId === null ? "in use" : "use",
            disabled: data.activeId === null,
            title: "fall back to whichever llama-server is on PATH",
            onclick: () => void mutate(() => api.setActiveInstall(null)),
          }),
        ),
      );
    }

    if (data.builds.length > 0) {
      out.push(el("div", { className: "section-title", textContent: "Builds" }));
      out.push(...data.builds.map(buildRow));
    }

    body.replaceChildren(...out);
  }

  render();
  void refreshDynamic();
  const unsubscribe = subscribe(render);
  openModal({
    title: "Managed llama.cpp installs",
    subtitle: "the active install supplies the binary the daemon spawns",
    body,
    footer: [el("button", { className: "primary", textContent: "+ Build from source", onclick: openBuildForm })],
    onClose: unsubscribe,
  });
}
