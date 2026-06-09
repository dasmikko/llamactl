/**
 * Details panel for the highlighted row: the full model metadata, file path,
 * runtime state + live stats when running, and the launch spec (from the
 * running child or the saved profile). Opened with `i`, closed with Esc.
 */

import React from "react";
import { Box, Text } from "ink";
import type { LaunchSpec } from "../types.ts";
import type { Row } from "./rows.ts";
import { humanBytes, humanUptime, pct } from "./format.ts";

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

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box>
      <Box width={16}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

export function ModelInfo({ row, now }: ModelInfoProps): React.ReactElement {
  const { model, instance, running, stats } = row;
  const spec = running?.spec ?? instance?.spec;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {row.name}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Field label="Model id" value={model?.id ?? row.modelId} />
        <Field label="Author" value={model?.org ?? "—"} />
        <Field label="Architecture" value={model?.arch ?? "—"} />
        <Field label="Kind" value={model?.kind ?? "—"} />
        <Field label="Quant" value={row.quant ?? "—"} />
        <Field label="Size" value={row.sizeBytes != null ? humanBytes(row.sizeBytes) : "—"} />
        <Field label="Context (max)" value={ctxText(model?.contextLength)} />
        <Field label="Source" value={model?.source ?? "—"} />
        <Field label="Path" value={model?.path ?? "—"} />
      </Box>

      {running ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Running</Text>
          <Field label="Status" value={running.status} />
          <Field label="Endpoint" value={`http://127.0.0.1:${running.port}`} />
          <Field label="PID" value={String(running.pid)} />
          <Field label="Uptime" value={humanUptime(running.startedAt, now)} />
          <Field label="Restarts" value={String(running.restarts)} />
          {stats ? (
            <Field
              label="CPU / RAM / VRAM"
              value={`${pct(stats.cpuPct)}  ${humanBytes(stats.rssBytes)}  ${humanBytes(stats.vramBytes)}`}
            />
          ) : null}
          <Field label="Log" value={running.logPath} />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>
          {running ? "Launched with" : instance ? `Profile "${instance.name}"` : "Launch flags"}
        </Text>
        {spec ? (
          specLines(spec).map((l, i) => (
            <Text key={i} dimColor>
              {"  " + l}
            </Text>
          ))
        ) : (
          <Text dimColor>{"  (no saved profile — uses defaults; press e to edit)"}</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Esc or i to close</Text>
      </Box>
    </Box>
  );
}
