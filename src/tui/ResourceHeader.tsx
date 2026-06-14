/**
 * Top resource panel: a title/connection line, then two columns — live CPU/RAM
 * (and per-GPU) gauges on the left, and the daemon's facts (PID, uptime, port,
 * and model/instance/profile counts) on the right — plus any warnings. Pure-ish
 * presentational component memoized on its props so it only re-renders when a new
 * stats sample lands.
 */

import React from "react";
import { Box, Text } from "ink";
import type { LlamaServerInfo, StatsSnapshot } from "../types.ts";
import { bar, pct, humanBytes, humanUptime } from "./format.ts";

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

function ResourceHeaderImpl({
  stats,
  llamaServer,
  activeInstallName,
  error,
  connected,
  daemon,
  now,
  modelsCount,
  runningCount,
  profilesCount,
  downloadingCount,
}: ResourceHeaderProps): React.ReactElement {
  const sys = stats?.system;
  const cpu = sys ? clamp100(sys.cpuPct) : 0;
  const memUsed = sys?.memUsed ?? 0;
  const memTotal = sys?.memTotal ?? 0;

  // Right-column daemon facts as a label/value list, beside the gauges.
  const port = daemon ? portOf(daemon.controlUrl) : null;
  const daemonRows: Array<[string, string]> = daemon
    ? [
        ["PID", String(daemon.pid)],
        ["Uptime", humanUptime(daemon.startedAt, now)],
        ["Port", port ?? "—"],
        ["Models", String(modelsCount)],
        ["Running", String(runningCount)],
        ["Profiles", String(profilesCount)],
        ...(downloadingCount > 0
          ? ([["Downloads", String(downloadingCount)]] as Array<[string, string]>)
          : []),
      ]
    : [];

  const gauges = (
    <Box flexDirection="column">
      <Box>
        <Box width={6}>
          <Text>CPU</Text>
        </Box>
        <Text color="cyan">{bar(cpu, 100, GAUGE_WIDTH)}</Text>
        <Text> {pct(cpu)}</Text>
        {sys?.tempC != null ? <Text>{`  ${sys.tempC}°C`}</Text> : null}
      </Box>

      <Box>
        <Box width={6}>
          <Text>RAM</Text>
        </Box>
        <Text color="cyan">{bar(memUsed, memTotal, GAUGE_WIDTH)}</Text>
        <Text>
          {" "}
          {humanBytes(memUsed)} / {humanBytes(memTotal)}
        </Text>
      </Box>

      {stats?.gpuAvailable
        ? stats.gpus.map((g) => {
            // Label VRAM rows per-index only when there's more than one GPU.
            const vramLabel = stats.gpus.length > 1 ? `VRAM${g.index}` : "VRAM";
            return (
              <React.Fragment key={g.index}>
                <Box>
                  <Box width={6}>
                    <Text>GPU{g.index}</Text>
                  </Box>
                  <Text color="magenta">{bar(clamp100(g.utilPct), 100, GAUGE_WIDTH)}</Text>
                  <Text>
                    {" "}
                    {pct(g.utilPct)}
                    {g.tempC != null ? `  ${g.tempC}°C` : ""} {g.name}
                  </Text>
                </Box>
                <Box>
                  <Box width={6}>
                    <Text>{vramLabel}</Text>
                  </Box>
                  <Text color="blue">{bar(g.vramUsed, g.vramTotal, GAUGE_WIDTH)}</Text>
                  <Text>
                    {" "}
                    {humanBytes(g.vramUsed)} / {humanBytes(g.vramTotal)}
                  </Text>
                </Box>
              </React.Fragment>
            );
          })
        : null}
    </Box>
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        <Text bold>🦙 llamactl</Text>
        <Text>  </Text>
        {connected ? (
          <Text color="green">● connected to daemon</Text>
        ) : (
          <Text color="yellow">○ connecting…</Text>
        )}
        {llamaServer?.found && llamaServer.version ? (
          <Text dimColor>{`  llama-server ${llamaServer.version}`}</Text>
        ) : null}
        {activeInstallName ? (
          <Text color="cyan">{`  ▸ ${activeInstallName}`}</Text>
        ) : null}
      </Box>

      {/* Two columns: live gauges on the left, daemon facts on the right. */}
      <Box flexDirection="row">
        {gauges}
        {daemonRows.length > 0 ? (
          <Box
            flexDirection="column"
            marginLeft={2}
            paddingLeft={2}
            borderStyle="round"
            borderColor="gray"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            {daemonRows.map(([label, value]) => (
              <Box key={label}>
                <Box width={11}>
                  <Text dimColor>{label}</Text>
                </Box>
                <Text>{value}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>

      {llamaServer && !llamaServer.found ? (
        <Box>
          <Text color="red">
            ⚠ llama-server not found ({llamaServer.path}) — set llamaServerPath or add it to PATH
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box>
          <Text color="red">⚠ {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const ResourceHeader = React.memo(ResourceHeaderImpl);
