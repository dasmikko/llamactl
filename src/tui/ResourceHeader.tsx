/**
 * Top resource panel: a title/connection line, then two columns — live CPU/RAM
 * (and per-GPU) gauges on the left, and the daemon's facts (PID, uptime, port,
 * and model/instance/profile counts) on the right — plus any warnings.
 * Presentational; reads reactive props so it repaints when a new stats sample
 * lands.
 */

import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { LlamaServerInfo, StatsSnapshot } from "../types.ts";
import { bar, pct, humanBytes, humanUptime } from "./format.ts";
import { C } from "./theme.ts";

export interface ResourceHeaderProps {
  stats: StatsSnapshot | null;
  llamaServer: LlamaServerInfo | null;
  /** Name of the active managed install supplying the binary, or null for PATH. */
  activeInstallName: string | null;
  error: string | null;
  connected: boolean;
  /** The connected daemon's runtime (PID / control URL / start time), or null. */
  daemon: { pid: number; controlUrl: string; startedAt: number } | null;
  /** Periodic "now" (epoch ms) so the daemon uptime ticks. */
  now: number;
  /** Number of discovered (runnable) models. */
  modelsCount: number;
  /** Number of running llama-server instances. */
  runningCount: number;
  /** Number of saved launch profiles. */
  profilesCount: number;
  /** Number of downloads currently in flight. */
  downloadingCount: number;
}

// Narrow gauges leave horizontal room on each line for the daemon stats.
const GAUGE_WIDTH = 12;

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** The control-plane port pulled out of a URL like "http://127.0.0.1:48134". */
function portOf(url: string): string | null {
  const m = url.match(/:(\d+)\b/);
  return m ? m[1]! : null;
}

export function ResourceHeader(props: ResourceHeaderProps) {
  // Derived accessors (the body runs once under Solid).
  const sys = () => props.stats?.system;
  const cpu = () => {
    const s = sys();
    return s ? clamp100(s.cpuPct) : 0;
  };
  const memUsed = () => sys()?.memUsed ?? 0;
  const memTotal = () => sys()?.memTotal ?? 0;

  // Right-column daemon facts as a label/value list, beside the gauges.
  const daemonRows = (): Array<[string, string]> => {
    const d = props.daemon;
    if (!d) return [];
    const port = portOf(d.controlUrl);
    return [
      ["PID", String(d.pid)],
      ["Uptime", humanUptime(d.startedAt, props.now)],
      ["Port", port ?? "—"],
      ["Models", String(props.modelsCount)],
      ["Running", String(props.runningCount)],
      ["Profiles", String(props.profilesCount)],
      ...(props.downloadingCount > 0
        ? ([["Downloads", String(props.downloadingCount)]] as Array<[string, string]>)
        : []),
    ];
  };

  const gauges = (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={6}>
          <text>CPU</text>
        </box>
        <text fg={C.accent}>{bar(cpu(), 100, GAUGE_WIDTH)}</text>
        <text> {pct(cpu())}</text>
        <Show when={sys()?.tempC != null}>
          <text>{`  ${sys()!.tempC}°C`}</text>
        </Show>
      </box>

      <box flexDirection="row">
        <box width={6}>
          <text>RAM</text>
        </box>
        <text fg={C.accent}>{bar(memUsed(), memTotal(), GAUGE_WIDTH)}</text>
        <text>
          {" "}
          {humanBytes(memUsed())} / {humanBytes(memTotal())}
        </text>
      </box>

      <Show when={props.stats?.gpuAvailable}>
        <For each={props.stats!.gpus}>
          {(g) => {
            const vramLabel = props.stats!.gpus.length > 1 ? `VRAM${g.index}` : "VRAM";
            return (
              <>
                <box flexDirection="row">
                  <box width={6}>
                    <text>GPU{g.index}</text>
                  </box>
                  <text fg={C.accent2}>{bar(clamp100(g.utilPct), 100, GAUGE_WIDTH)}</text>
                  <text>
                    {" "}
                    {pct(g.utilPct)}
                    {g.tempC != null ? `  ${g.tempC}°C` : ""} {g.name}
                  </text>
                </box>
                <box flexDirection="row">
                  <box width={6}>
                    <text>{vramLabel}</text>
                  </box>
                  <text fg={C.info}>{bar(g.vramUsed, g.vramTotal, GAUGE_WIDTH)}</text>
                  <text>
                    {" "}
                    {humanBytes(g.vramUsed)} / {humanBytes(g.vramTotal)}
                  </text>
                </box>
              </>
            );
          }}
        </For>
      </Show>
    </box>
  );

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.border} paddingX={1}>
      <box flexDirection="row">
        <text fg={C.accent} attributes={TextAttributes.BOLD}>🦙 llamactl</text>
        <text>{"  "}</text>
        <Show
          when={props.connected}
          fallback={<text fg={C.warning}>○ connecting…</text>}
        >
          <text fg={C.success}>● connected to daemon</text>
        </Show>
        <Show when={props.llamaServer?.found && props.llamaServer.version}>
          <text attributes={TextAttributes.DIM}>{`  llama-server ${props.llamaServer!.version}`}</text>
        </Show>
        <Show when={props.activeInstallName}>
          <text fg={C.accent}>{`  ▸ ${props.activeInstallName}`}</text>
        </Show>
      </box>

      {/* Two columns: live gauges on the left, daemon facts on the right. */}
      <box flexDirection="row">
        {gauges}
        <Show when={daemonRows().length > 0}>
          <box
            flexDirection="column"
            marginLeft={2}
            paddingLeft={2}
            border={["left"]}
            borderStyle="rounded"
            borderColor={C.muted}
          >
            <For each={daemonRows()}>
              {([label, value]) => (
                <box flexDirection="row">
                  <box width={11}>
                    <text attributes={TextAttributes.DIM}>{label}</text>
                  </box>
                  <text>{value}</text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>

      <Show when={props.llamaServer && !props.llamaServer.found}>
        <box flexDirection="row">
          <text fg={C.danger}>
            ⚠ llama-server not found ({props.llamaServer!.path}) — set llamaServerPath or add it to PATH
          </text>
        </box>
      </Show>

      <Show when={props.error}>
        <box flexDirection="row">
          <text fg={C.danger}>⚠ {props.error}</text>
        </box>
      </Show>
    </box>
  );
}
