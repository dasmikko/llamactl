/**
 * Details panel for one row — the web counterpart of src/tui/ModelInfo.tsx:
 * full model metadata, runtime state with live stats, startup warnings, and the
 * launch flags (from the running child, the saved profile, or every profile the
 * model has).
 */

import { CURATED_FLAGS } from "/mod/instances/spec.js";
import { el, bytes, uptime, pct, ctxText } from "../lib/dom.js";
import { openModal } from "./modal.js";

/**
 * Render the set fields of a LaunchSpec as "flag value" lines. Mirrors
 * `specToArgs` (same fields, same order, same on/off semantics) so what the
 * panel shows is what the child is, or would be, launched with.
 */
export function specLines(spec) {
  const out = [];
  const add = (k, v) => {
    if (v !== undefined && v !== "") out.push(`${k} ${v}`);
  };
  add("--alias", spec.alias);
  add("--ctx-size", spec.ctxSize);
  add("--gpu-layers", spec.gpuLayers);
  add("--n-cpu-moe", spec.nCpuMoe);
  add("--threads", spec.threads);
  add("--batch-size", spec.batchSize);
  add("--ubatch-size", spec.ubatchSize);
  add("--parallel", spec.parallel);
  add("--mmproj", spec.mmproj);
  add("--spec-draft-model", spec.specDraftModel);
  // Enable-only flags: --mlock when on, --no-mmap when mmap is off.
  if (spec.mlock === "on") out.push("--mlock");
  if (spec.mmap === "off") out.push("--no-mmap");
  if (spec.flashAttn) add("--flash-attn", spec.flashAttn);
  if (spec.reasoning) add("--reasoning", spec.reasoning);
  if (spec.jinja) out.push(spec.jinja === "off" ? "--no-jinja" : "--jinja");
  add("--cache-type-k", spec.cacheTypeK);
  add("--cache-type-v", spec.cacheTypeV);
  add("--chat-template", spec.chatTemplate);
  add("--host", spec.host);
  add("--port", spec.port);
  for (const [flag, value] of Object.entries(spec.extraFlags ?? {})) {
    if (CURATED_FLAGS.has(flag)) continue; // skipped by specToArgs too
    if (value === true) out.push(flag);
    else if (value !== "") out.push(`${flag} ${value}`);
  }
  if (spec.extraArgs?.length > 0) out.push(spec.extraArgs.join(" "));
  return out.length > 0 ? out : ["(defaults)"];
}

function fieldRow(label, value) {
  return el(
    "div",
    { className: "field" },
    el("label", { textContent: label }),
    el("span", { textContent: value }),
  );
}

function flagBlock(lines, indent = "") {
  return el(
    "div",
    { className: "dim" },
    ...lines.map((l) => el("div", { textContent: indent + l })),
  );
}

export function openInfo(row) {
  const model = row.model;
  const running = row.running;
  const stats = row.stats;
  const spec = running?.spec ?? row.instance?.spec;

  const body = el("div", {});

  body.append(
    fieldRow("Model id", model?.id ?? row.modelId),
    fieldRow("Author", model?.org ?? "—"),
    fieldRow("Architecture", model?.arch ?? "—"),
    fieldRow("Kind", model?.kind ?? "—"),
    fieldRow("Quant", row.quant ?? "—"),
    fieldRow("Size", row.sizeBytes !== null ? bytes(row.sizeBytes) : "—"),
    fieldRow("Context (max)", ctxText(model?.contextLength)),
    fieldRow("Source", model?.source ?? "—"),
    fieldRow("Path", model?.path ?? "—"),
  );

  if (running) {
    const host = running.spec.host ?? "127.0.0.1";
    body.append(
      el("fieldset", {}, el("legend", { textContent: "Running" })),
      fieldRow("Status", running.status),
      fieldRow("Endpoint", `http://${host}:${running.port}`),
      fieldRow("PID", String(running.pid)),
      fieldRow("Uptime", uptime(running.startedAt)),
      fieldRow("Restarts", String(running.restarts)),
      stats
        ? fieldRow(
            "CPU / RAM / VRAM",
            `${pct(stats.cpuPct)}  ${bytes(stats.rssBytes)}  ${bytes(stats.vramBytes)}`,
          )
        : null,
      fieldRow("Log", running.logPath),
    );
  }

  // Soft failures scraped from the startup log: llama-server warns and serves
  // anyway, so a "ready" child can be quietly misconfigured.
  if (running?.warnings?.length) {
    body.append(
      el("fieldset", {}, el("legend", { className: "warn", textContent: "Startup warnings" })),
      ...running.warnings.map((w) => el("div", { className: "warn", textContent: w })),
    );
  }

  const flagsTitle = running
    ? "Launched with"
    : row.instance
      ? `Profile "${row.instance.name}"`
      : row.profiles.length > 0
        ? `Profiles (${row.profiles.length})`
        : "Launch flags";
  body.append(el("fieldset", {}, el("legend", { textContent: flagsTitle })));

  if (spec) {
    body.append(flagBlock(specLines(spec)));
  } else if (row.profiles.length > 0) {
    for (const p of row.profiles) {
      body.append(
        el("div", { style: { color: "var(--violet)" }, textContent: p.name }),
        flagBlock(specLines(p.spec), "  "),
      );
    }
  } else {
    body.append(el("div", { className: "dim", textContent: "(no saved profile — uses defaults)" }));
  }

  openModal({
    title: row.name,
    subtitle: model?.repo ? `huggingface.co/${model.repo}` : "",
    subtitleHref: model?.repo ? `https://huggingface.co/${model.repo}` : null,
    body,
  });
}
