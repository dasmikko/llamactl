/**
 * Managed llama.cpp installs view: a list of built installs (one is active and
 * supplies the spawned binary) plus any in-flight / recent build jobs with live
 * progress. Pure/presentational — selection and keys live in app.tsx.
 */

import React from "react";
import { Box, Text } from "ink";
import type { LlamaInstall, BuildJob, BuildStatus } from "../types.ts";
import { humanBytes } from "./format.ts";

export interface InstallsProps {
  installs: LlamaInstall[];
  builds: BuildJob[];
  activeId: string | null;
  /** Index into `installs` of the highlighted row, or -1 when none. */
  selectedIndex: number;
  /** Index into `builds` of the highlighted build row, or -1 when none. */
  selectedBuildIndex: number;
  /** Terminal width, so the build-log tail can be truncated to fit. */
  width: number;
}

function buildStatusColor(status: BuildStatus): string | undefined {
  switch (status) {
    case "ready":
      return "green";
    case "error":
      return "red";
    case "canceled":
      return "yellow";
    case "queued":
      return "gray";
    default:
      return "cyan";
  }
}

/** True while a build is still running (so its log tail is worth surfacing). */
function buildInFlight(status: BuildStatus): boolean {
  return (
    status === "queued" ||
    status === "cloning" ||
    status === "fetching" ||
    status === "configuring" ||
    status === "building" ||
    status === "installing"
  );
}

function InstallsImpl({
  installs,
  builds,
  activeId,
  selectedIndex,
  selectedBuildIndex,
  width,
}: InstallsProps): React.ReactElement {
  // Reserve a margin so the truncated log tail never wraps the terminal.
  const tailWidth = Math.max(10, width - 6);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
    >
      <Text bold color="blue">
        MANAGED LLAMA.CPP INSTALLS
      </Text>

      <Box>
        <Box width={2}>
          <Text> </Text>
        </Box>
        <Box width={22}>
          <Text dimColor>NAME</Text>
        </Box>
        <Box width={16}>
          <Text dimColor>REF</Text>
        </Box>
        <Box width={7}>
          <Text dimColor>BACKEND</Text>
        </Box>
        <Box width={16}>
          <Text dimColor>VERSION</Text>
        </Box>
        <Box width={10}>
          <Text dimColor>SIZE</Text>
        </Box>
      </Box>

      {installs.length === 0 ? (
        <Text dimColor>(no managed installs — press n to build one)</Text>
      ) : (
        installs.map((ins, i) => {
          const selected = i === selectedIndex;
          const active = ins.id === activeId;
          return (
            <Box key={ins.id}>
              <Box width={2}>
                <Text color="#ff8700">{active ? "★" : " "}</Text>
              </Box>
              <Box width={22}>
                <Text inverse={selected} wrap="truncate-end">
                  {(selected ? "› " : "  ") + ins.name}
                </Text>
              </Box>
              <Box width={16}>
                <Text wrap="truncate-end">{ins.ref}</Text>
              </Box>
              <Box width={7}>
                <Text>{ins.backend}</Text>
              </Box>
              <Box width={16}>
                <Text wrap="truncate-end">{ins.version ?? "—"}</Text>
              </Box>
              <Box width={10}>
                <Text>{ins.sizeBytes != null ? humanBytes(ins.sizeBytes) : "—"}</Text>
              </Box>
              {active ? <Text dimColor> (active)</Text> : null}
            </Box>
          );
        })
      )}

      {builds.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">
            BUILDS
          </Text>
          {builds.slice(0, 5).map((b, i) => {
            const selected = i === selectedBuildIndex;
            const inFlight = buildInFlight(b.status);
            const tail = b.logTail.length > 0 ? b.logTail[b.logTail.length - 1]! : "";
            const hint =
              b.status === "error"
                ? (b.error ?? "build failed")
                : inFlight
                  ? tail
                  : b.status;
            return (
              <Box key={b.id}>
                <Box width={22}>
                  <Text inverse={selected} wrap="truncate-end">
                    {(selected ? "› " : "  ") + b.name}
                  </Text>
                </Box>
                <Box width={12}>
                  <Text color={buildStatusColor(b.status)}>{b.status}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={b.status === "error" ? "red" : undefined}
                    dimColor={inFlight}
                    wrap="truncate-end"
                  >
                    {hint.length > tailWidth ? hint.slice(0, tailWidth - 1) + "…" : hint}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          j/k move · Enter set active / view log · l log · r rename · u update · c cancel · d remove · n new · Esc close
        </Text>
      </Box>
    </Box>
  );
}

export const Installs = React.memo(InstallsImpl);
