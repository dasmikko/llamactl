/**
 * The merged main list. Pure presentational: it receives already-joined and
 * already-filtered rows plus the selected index, and renders a fixed-width
 * table. Memoized so the 1.5s poll only repaints when the row data changes.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Row } from "./rows.ts";
import { pct, humanBytes, humanUptime } from "./format.ts";

export interface TableProps {
  rows: Row[];
  /** Index of the selected row within `rows`, or -1 if the selection is elsewhere. */
  selectedIndex: number;
  /** Whether GPU/VRAM columns should be shown. */
  gpuAvailable: boolean;
  /** "now" epoch ms, passed in so uptime is computed off a stable tick. */
  now: number;
  /** Section heading rendered above the column header. */
  title?: string;
  /** Color of the section heading (any Ink color, incl. hex). Defaults to cyan. */
  titleColor?: string;
  /** "full" shows runtime columns; "catalog" shows just name/quant/size/status. */
  variant?: "full" | "catalog";
  /** Placeholder shown when there are no rows. */
  emptyText?: string;
  /** Whether this table grows to fill remaining vertical space. */
  fill?: boolean;
  /** Terminal width; the NAME column stretches to fill it when provided. */
  width?: number;
  /**
   * Max number of data rows to render at once. When the list is longer the
   * table windows around the selected row and shows scroll indicators. Omit to
   * render every row (no scrolling).
   */
  maxRows?: number;
}

/** Columns shown in the compact "catalog" variant (the model list). */
const CATALOG_HEADERS = new Set(["NAME", "AUTHOR", "ARCH", "MODE", "QUANT", "SIZE", "CTX", "STATUS"]);

interface ColumnDef {
  header: string;
  width: number;
  alignRight?: boolean;
  get: (row: Row, now: number) => string;
  /** Only shown when GPU is available. */
  gpuOnly?: boolean;
  /** Only shown in the "catalog" (model list) variant. */
  catalogOnly?: boolean;
}

function statusText(row: Row): string {
  if (row.running) return row.running.status;
  if (row.instance) return "profile";
  return "—";
}

/** Humanize a supported context length: 32768 → "32K", 131072 → "128K". */
function ctxHuman(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

const COLUMNS: ColumnDef[] = [
  { header: "NAME", width: 26, get: (r) => r.name },
  { header: "AUTHOR", width: 14, catalogOnly: true, get: (r) => r.model?.org ?? "—" },
  { header: "ARCH", width: 9, catalogOnly: true, get: (r) => r.model?.arch ?? "—" },
  { header: "MODE", width: 6, catalogOnly: true, get: (r) => r.model?.kind ?? "—" },
  { header: "QUANT", width: 9, get: (r) => r.quant ?? "—" },
  {
    header: "SIZE",
    width: 10,
    alignRight: true,
    get: (r) => (r.sizeBytes == null ? "—" : humanBytes(r.sizeBytes)),
  },
  {
    header: "CTX",
    width: 7,
    alignRight: true,
    catalogOnly: true,
    get: (r) => ctxHuman(r.model?.contextLength),
  },
  { header: "STATUS", width: 9, get: statusText },
  {
    header: "PORT",
    width: 6,
    alignRight: true,
    get: (r) => (r.running ? String(r.running.port) : "—"),
  },
  {
    header: "PID",
    width: 7,
    alignRight: true,
    get: (r) => (r.running ? String(r.running.pid) : "—"),
  },
  {
    header: "CPU%",
    width: 7,
    alignRight: true,
    // Per-pid CPU% can exceed 100% (percent of one core) — deliberately not clamped.
    get: (r) => (r.stats ? pct(r.stats.cpuPct) : "—"),
  },
  {
    header: "RAM",
    width: 10,
    alignRight: true,
    get: (r) => (r.stats ? humanBytes(r.stats.rssBytes) : "—"),
  },
  {
    header: "VRAM",
    width: 10,
    alignRight: true,
    gpuOnly: true,
    get: (r) => (r.stats ? humanBytes(r.stats.vramBytes) : "—"),
  },
  {
    header: "UPTIME",
    width: 9,
    alignRight: true,
    get: (r, now) =>
      r.running ? humanUptime(r.running.startedAt, now) : "—",
  },
];

/**
 * Pick the [start, end) slice of `total` rows to show in `capacity` lines,
 * keeping `selected` visible by centering it. With the selection off-screen
 * (-1) it anchors to the top.
 */
export function windowSlice(
  total: number,
  selected: number,
  capacity: number,
): { start: number; end: number } {
  if (total <= capacity) return { start: 0, end: total };
  const anchor = selected < 0 ? 0 : selected;
  let start = anchor - Math.floor(capacity / 2);
  start = Math.max(0, Math.min(start, total - capacity));
  return { start, end: start + capacity };
}

function pad(s: string, width: number, right: boolean): string {
  if (s.length > width) return s.slice(0, Math.max(0, width - 1)) + "…";
  return right ? s.padStart(width) : s.padEnd(width);
}

/** Width of the leading star gutter (the star glyph + a trailing space). */
const FAV_GUTTER = 2;
/** Filled star for a favorited row; a space otherwise (keeps columns aligned). */
const FAV_STAR = "★";

function statusColor(row: Row): string | undefined {
  if (!row.running) return undefined;
  switch (row.running.status) {
    case "ready":
      return "green";
    case "starting":
      return "yellow";
    case "stopping":
      return "yellow";
    case "crashed":
      return "red";
    default:
      return undefined;
  }
}

function TableImpl({
  rows,
  selectedIndex,
  gpuAvailable,
  now,
  title,
  titleColor = "cyan",
  variant = "full",
  emptyText = "(none)",
  fill = false,
  width,
  maxRows,
}: TableProps): React.ReactElement {
  const baseCols = COLUMNS.filter((c) => {
    if (variant === "catalog") return CATALOG_HEADERS.has(c.header);
    return !c.catalogOnly && (!c.gpuOnly || gpuAvailable);
  });

  // Stretch the NAME column so the row (and selection bar) fills the terminal.
  // The leading star gutter eats FAV_GUTTER columns, so the NAME column gives
  // those back to keep the row total exactly `width`.
  const cols = (() => {
    if (!width) return baseCols;
    const others = baseCols.reduce((s, c) => (c.header === "NAME" ? s : s + c.width), 0);
    const seps = baseCols.length - 1;
    const nameWidth = Math.max(20, width - others - seps - FAV_GUTTER);
    return baseCols.map((c) => (c.header === "NAME" ? { ...c, width: nameWidth } : c));
  })();

  // Every row is prefixed with the star gutter; the header reserves the same
  // blank space so the columns stay aligned underneath it.
  const headerLine =
    " ".repeat(FAV_GUTTER) +
    cols.map((c) => pad(c.header, c.width, c.alignRight ?? false)).join(" ");

  // Window the rows when there are more than will fit, reserving one line for
  // the scroll indicator. The selected row stays in view (see windowSlice).
  const scrolling = maxRows != null && rows.length > maxRows;
  const { start, end } = scrolling
    ? windowSlice(rows.length, selectedIndex, Math.max(1, maxRows - 1))
    : { start: 0, end: rows.length };
  const visible = rows.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;

  return (
    <Box flexDirection="column" flexGrow={fill ? 1 : 0}>
      {title ? (
        <Text bold color={titleColor}>
          {title}
        </Text>
      ) : null}
      <Text bold color="gray">
        {headerLine}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>{emptyText}</Text>
      ) : (
        visible.map((row, i) => {
          const selected = start + i === selectedIndex;
          const star = row.isFavorite ? FAV_STAR : " ";
          const line = cols
            .map((c) => pad(c.get(row, now), c.width, c.alignRight ?? false))
            .join(" ");
          // Selected rows invert the whole line (star included) so the highlight
          // bar is unbroken; unselected rows color the star gold independently of
          // the status color applied to the rest of the row.
          if (selected) {
            return (
              <Text key={row.modelId} inverse>
                {star} {line}
              </Text>
            );
          }
          const sc = statusColor(row);
          return (
            <Text key={row.modelId}>
              <Text color="yellow">{star}</Text>{" "}
              <Text color={sc}>{line}</Text>
            </Text>
          );
        })
      )}
      {scrolling ? (
        <Text dimColor>
          {hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : ""}
          {hiddenAbove > 0 && hiddenBelow > 0 ? "   " : ""}
          {hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : ""}
        </Text>
      ) : null}
    </Box>
  );
}

export const Table = React.memo(TableImpl);
