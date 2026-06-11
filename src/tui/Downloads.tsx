/**
 * Downloads section: a compact progress list of active and recently-finished
 * Hugging Face downloads, shown above the model lists. Pure/memoized.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Download } from "../types.ts";
import { bar, pct, humanBytes } from "./format.ts";

export interface DownloadsProps {
  downloads: Download[];
  /** Index of the highlighted row in the managed view, or -1 for none (inline). */
  selectedIndex?: number;
  /** Render the "DOWNLOADS" header (default true; the managed view supplies its own). */
  showHeader?: boolean;
}

const GAUGE_WIDTH = 16;

function statusColor(status: Download["status"]): string | undefined {
  switch (status) {
    case "done":
      return "green";
    case "error":
      return "red";
    case "canceled":
      return "yellow";
    default:
      return "cyan";
  }
}

function DownloadsImpl({
  downloads,
  selectedIndex = -1,
  showHeader = true,
}: DownloadsProps): React.ReactElement | null {
  if (downloads.length === 0) return null;
  // The managed view passes a selection and wants all rows; the inline strip
  // caps at 5. (selectedIndex >= 0 ⇒ managed view.)
  const managed = selectedIndex >= 0;
  const rows = managed ? downloads : downloads.slice(0, 5);
  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Text bold color="magenta">
          DOWNLOADS
        </Text>
      ) : null}
      {rows.map((d, i) => {
        const selected = i === selectedIndex;
        const frac = d.totalBytes ? d.receivedBytes / d.totalBytes : 0;
        const label = `${d.repo}/${d.file.split("/").pop() ?? d.file}`;
        const size = d.totalBytes
          ? `${humanBytes(d.receivedBytes)} / ${humanBytes(d.totalBytes)}`
          : humanBytes(d.receivedBytes);
        return (
          <Box key={d.id}>
            {managed ? (
              <Box width={2}>
                <Text>{selected ? "›" : " "}</Text>
              </Box>
            ) : null}
            <Box width={36}>
              <Text inverse={selected}>{label.length > 35 ? "…" + label.slice(-34) : label}</Text>
            </Box>
            <Text color={statusColor(d.status)}>{bar(d.receivedBytes, d.totalBytes ?? 0, GAUGE_WIDTH)}</Text>
            <Text>
              {" "}
              {d.status === "downloading" ? pct(frac * 100) : d.status}
              {"  " + size}
            </Text>
            {managed && d.status === "error" && d.error ? (
              <Text color="red"> — {d.error}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export const Downloads = React.memo(DownloadsImpl);
