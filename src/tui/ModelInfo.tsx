/**
 * Details panel for the highlighted row: the full model metadata, file path,
 * runtime state + live stats when running, and the launch spec (from the
 * running child or the saved profile). Opened with `i`, closed with Esc.
 */

import { For, Show, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { LaunchSpec } from "../types.ts";
import type { Row } from "./rows.ts";
import { humanBytes, humanUptime, pct } from "./format.ts";
import { parseRepo } from "../discovery/models.ts";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { C } from "./theme.ts";

export interface ModelInfoProps {
  row: Row;
  now: number;
}

/** Format a supported context length, e.g. 131072 → "131072 (128K)". */
function ctxText(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1024) return `${n} (${Math.round(n / 1024)}K)`;
  return String(n);
}

/** Render the set fields of a LaunchSpec as "flag value" lines. */
function specLines(spec: LaunchSpec): string[] {
  const out: string[] = [];
  const add = (k: string, v: unknown): void => {
    if (v !== undefined && v !== "") out.push(`${k} ${v}`);
  };
  add("--ctx-size", spec.ctxSize);
  add("--gpu-layers", spec.gpuLayers);
  add("--n-cpu-moe", spec.nCpuMoe);
  add("--threads", spec.threads);
  add("--batch-size", spec.batchSize);
  if (spec.flashAttn) add("--flash-attn", spec.flashAttn);
  if (spec.reasoning) add("--reasoning", spec.reasoning);
  if (spec.jinja) add(spec.jinja === "off" ? "--no-jinja" : "--jinja", "");
  add("--cache-type-k", spec.cacheTypeK);
  add("--cache-type-v", spec.cacheTypeV);
  add("--chat-template", spec.chatTemplate);
  add("--host", spec.host);
  add("--port", spec.port);
  if (spec.extraArgs && spec.extraArgs.length > 0) out.push(spec.extraArgs.join(" "));
  return out.length > 0 ? out : ["(defaults)"];
}

function Field(props: { label: string; value: string }): JSX.Element {
  return (
    <box flexDirection="row">
      <box width={16}>
        <text fg={C.text} attributes={TextAttributes.DIM}>{props.label}</text>
      </box>
      <text fg={C.text}>{props.value}</text>
    </box>
  );
}

export function ModelInfo(props: ModelInfoProps) {
  // Derived accessors (the body runs once under Solid).
  const model = () => props.row.model;
  const instance = () => props.row.instance;
  const running = () => props.row.running;
  const stats = () => props.row.stats;
  const profiles = () => props.row.profiles;
  const spec = () => running()?.spec ?? instance()?.spec;
  const repo = () => {
    const m = model();
    return m ? parseRepo(m.path) : null;
  };

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.border} backgroundColor={C.surface} paddingX={1}>
      <text fg={C.accent} attributes={TextAttributes.BOLD}>
        {props.row.name}
      </text>
      <Show when={repo()}>
        <text fg={C.text} attributes={TextAttributes.DIM}>{`huggingface.co/${repo()}  (press h to open)`}</text>
      </Show>

      <box marginTop={1} flexDirection="column">
        <Field label="Model id" value={model()?.id ?? props.row.modelId} />
        <Field label="Author" value={model()?.org ?? "—"} />
        <Field label="Architecture" value={model()?.arch ?? "—"} />
        <Field label="Kind" value={model()?.kind ?? "—"} />
        <Field label="Quant" value={props.row.quant ?? "—"} />
        <Field label="Size" value={props.row.sizeBytes != null ? humanBytes(props.row.sizeBytes) : "—"} />
        <Field label="Context (max)" value={ctxText(model()?.contextLength)} />
        <Field label="Source" value={model()?.source ?? "—"} />
        <Field label="Path" value={model()?.path ?? "—"} />
      </box>

      <Show when={running()}>
        <box marginTop={1} flexDirection="column">
          <text fg={C.text} attributes={TextAttributes.BOLD}>Running</text>
          <Field label="Status" value={running()!.status} />
          <Field label="Endpoint" value={`http://127.0.0.1:${running()!.port}`} />
          <Field label="PID" value={String(running()!.pid)} />
          <Field label="Uptime" value={humanUptime(running()!.startedAt, props.now)} />
          <Field label="Restarts" value={String(running()!.restarts)} />
          <Show when={stats()}>
            <Field
              label="CPU / RAM / VRAM"
              value={`${pct(stats()!.cpuPct)}  ${humanBytes(stats()!.rssBytes)}  ${humanBytes(stats()!.vramBytes)}`}
            />
          </Show>
          <Field label="Log" value={running()!.logPath} />
        </box>
      </Show>

      <box marginTop={1} flexDirection="column">
        <text fg={C.text} attributes={TextAttributes.BOLD}>
          {running()
            ? "Launched with"
            : instance()
              ? `Profile "${instance()!.name}"`
              : profiles().length > 0
                ? `Profiles (${profiles().length})`
                : "Launch flags"}
        </text>
        <Show
          when={spec()}
          fallback={
            <Show
              when={profiles().length > 0}
              fallback={
                <text fg={C.text} attributes={TextAttributes.DIM}>
                  {"  (no saved profile — uses defaults; press e to manage)"}
                </text>
              }
            >
              {/* A model row carries any number of named profiles; show each. */}
              <For each={profiles()}>
                {(p) => (
                  <box flexDirection="column">
                    <text fg={C.group}>{`  ${p.name}`}</text>
                    <For each={specLines(p.spec)}>
                      {(l) => <text fg={C.text} attributes={TextAttributes.DIM}>{"    " + l}</text>}
                    </For>
                  </box>
                )}
              </For>
            </Show>
          }
        >
          {/* A running child or an orphan profile row → one resolved spec. */}
          <For each={specLines(spec()!)}>
            {(l) => <text fg={C.text} attributes={TextAttributes.DIM}>{"  " + l}</text>}
          </For>
        </Show>
      </box>

      <box marginTop={1}>
        <ShortcutBar
          items={
            repo()
              ? [{ key: "Esc/i", desc: "close" }, { key: "h", desc: "HuggingFace" }]
              : [{ key: "Esc/i", desc: "close" }]
          }
        />
      </box>
    </box>
  );
}
