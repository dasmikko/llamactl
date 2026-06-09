/**
 * Top resource panel: system CPU% and RAM gauges, per-GPU lines when a GPU is
 * available, and a connection/error line. Pure-ish presentational component
 * memoized on its props so it only re-renders when a new stats sample lands.
 */

import React from "react";
import { Box, Text } from "ink";
import type { StatsSnapshot } from "../types.ts";
import { bar, pct, humanBytes } from "./format.ts";

export interface ResourceHeaderProps {
  stats: StatsSnapshot | null;
  error: string | null;
  connected: boolean;
}

const GAUGE_WIDTH = 20;

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function ResourceHeaderImpl({
  stats,
  error,
  connected,
}: ResourceHeaderProps): React.ReactElement {
  const sys = stats?.system;
  const cpu = sys ? clamp100(sys.cpuPct) : 0;
  const memUsed = sys?.memUsed ?? 0;
  const memTotal = sys?.memTotal ?? 0;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        <Text bold>llamactl</Text>
        <Text>  </Text>
        {connected ? (
          <Text color="green">● connected</Text>
        ) : (
          <Text color="yellow">○ connecting…</Text>
        )}
      </Box>

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

      {error ? (
        <Box>
          <Text color="red">⚠ {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const ResourceHeader = React.memo(ResourceHeaderImpl);
