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

function DownloadsImpl({ downloads }: DownloadsProps): React.ReactElement | null {
  if (downloads.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        DOWNLOADS
      </Text>
      {downloads.slice(0, 5).map((d) => {
        const frac = d.totalBytes ? d.receivedBytes / d.totalBytes : 0;
        const label = `${d.repo}/${d.file.split("/").pop() ?? d.file}`;
        const size = d.totalBytes
          ? `${humanBytes(d.receivedBytes)} / ${humanBytes(d.totalBytes)}`
          : humanBytes(d.receivedBytes);
        return (
          <Box key={d.id}>
            <Box width={36}>
              <Text>{label.length > 35 ? "…" + label.slice(-34) : label}</Text>
            </Box>
            <Text color={statusColor(d.status)}>{bar(d.receivedBytes, d.totalBytes ?? 0, GAUGE_WIDTH)}</Text>
            <Text>
              {" "}
              {d.status === "downloading" ? pct(frac * 100) : d.status}
              {"  " + size}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export const Downloads = React.memo(DownloadsImpl);
