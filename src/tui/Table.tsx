/**
 * The merged main list. Pure presentational: it receives already-joined and
 * already-filtered rows plus the selected index, and renders a fixed-width
 * table. Solid recomputes its derived accessors when the row data changes, so
 * the 1.5s poll only repaints the parts that actually changed.
 */

import { For, Show, createMemo, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { Row } from "./rows.ts";
import { pct, humanBytes, humanUptime } from "./format.ts";
import { C } from "./theme.ts";

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
  /** Color of the section heading (any color, incl. hex). Defaults to cyan. */
  titleColor?: string;
  /** "full" shows runtime columns; "catalog" shows just name/quant/size/status. */
  variant?: "full" | "catalog";
  /**
   * Group rows under a colored repo/author header (catalog only). Rows arrive
   * already clustered by `repo` from buildRows, so a header is emitted whenever
   * the repo changes and the variant names sit indented beneath it.
   */
  grouped?: boolean;
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

/** Columns shown in the compact "catalog" variant (the model list). The author
 *  is intentionally absent: in the catalog it's promoted to a repo group header. */
const CATALOG_HEADERS = new Set(["NAME", "ARCH", "MODE", "QUANT", "SIZE", "CTX", "STATUS"]);

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
  const n = row.profiles.length;
  if (n > 0) return n === 1 ? "1 prof" : `${n} profs`;
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
/** Header label for rows that have no parsed repo (bare local files). */
const NO_REPO_LABEL = "local models";

function statusColor(row: Row): string | undefined {
  if (!row.running) return undefined;
  switch (row.running.status) {
    case "ready":
      return C.success;
    case "starting":
      return C.warning;
    case "stopping":
      return C.warning;
    case "crashed":
      return C.danger;
    default:
      return undefined;
  }
}

export function Table(props: TableProps): JSX.Element {
  // Body runs once under Solid; everything derived from props is an accessor.
  const variant = () => props.variant ?? "full";
  const titleColor = () => props.titleColor ?? C.accent;
  const grouped = () => props.grouped ?? false;
  const emptyText = () => props.emptyText ?? "(none)";
  const fill = () => props.fill ?? false;

  const baseCols = () =>
    COLUMNS.filter((c) => {
      if (variant() === "catalog") return CATALOG_HEADERS.has(c.header);
      return !c.catalogOnly && (!c.gpuOnly || props.gpuAvailable);
    });

  // Stretch the NAME column so the row (and selection bar) fills the terminal.
  // The leading star gutter eats FAV_GUTTER columns, so the NAME column gives
  // those back to keep the row total exactly `width`.
  const cols = (): ColumnDef[] => {
    const base = baseCols();
    // The section is wrapped in a 1-cell border on each side, so the row content
    // is `width - 2` to fit inside it.
    const width = props.width == null ? undefined : props.width - 2;
    if (!width) return base;
    const others = base.reduce((s, c) => (c.header === "NAME" ? s : s + c.width), 0);
    const seps = base.length - 1;
    const nameWidth = Math.max(20, width - others - seps - FAV_GUTTER);
    return base.map((c) => (c.header === "NAME" ? { ...c, width: nameWidth } : c));
  };

  // Every row is prefixed with the star gutter; the header reserves the same
  // blank space so the columns stay aligned underneath it.
  const headerLine = () =>
    " ".repeat(FAV_GUTTER) +
    cols().map((c) => pad(c.header, c.width, c.alignRight ?? false)).join(" ");

  // The joined column text for one row (everything after the star gutter).
  const rowLine = (row: Row): string =>
    cols()
      .map((c) => pad(c.get(row, props.now), c.width, c.alignRight ?? false))
      .join(" ");

  // Render one data row at absolute index `idx`. The star gutter doubles as the
  // group indent in the grouped catalog (repo headers sit flush-left, rows hang
  // two columns in beneath them).
  //
  // Selected and unselected rows share the SAME structure — a row <box> of
  // sibling <text> runs (star, separator, line) — so the cursor moving never
  // swaps element shapes (which left highlight artifacts). Only attributes/fg
  // toggle, read REACTIVELY (accessors): selected rows invert every run (an
  // unbroken highlight bar); unselected rows color the star gold and the line by
  // status. The reactivity is what lets the highlight follow the cursor without
  // the <For> re-creating the row.
  const renderRow = (row: Row, idx: number): JSX.Element => {
    const selected = () => idx === props.selectedIndex;
    const star = row.isFavorite ? FAV_STAR : " ";
    const line = () => rowLine(row);
    // Selected rows paint a solid accent bar via an explicit background, rather
    // than INVERSE — it looks modern AND fully repaints the row cells, so no
    // stale highlight lingers as the cursor moves. Unselected rows are
    // transparent (the app's root background shows through): gold star + status/
    // default-colored line.
    const bg = () => (selected() ? C.sel : undefined);
    return (
      <box flexDirection="row">
        <text bg={bg()} fg={selected() ? C.selText : C.favorite}>{star}</text>
        <text bg={bg()} fg={C.selText}>{" "}</text>
        <text bg={bg()} fg={selected() ? C.selText : statusColor(row) ?? C.text}>{line()}</text>
      </box>
    );
  };

  const repoLabel = (r: Row): string => r.repo ?? NO_REPO_LABEL;
  const clamp = (s: string): string => {
    const width = props.width == null ? undefined : props.width - 2;
    return width && s.length > width ? s.slice(0, width - 1) + "…" : s;
  };

  // The chrome wraps the section in a rounded border with its name set into the
  // top border, over a column header and whichever body the grouped/flat branches
  // build.
  const chrome = (body: JSX.Element): JSX.Element => (
    <box
      flexDirection="column"
      flexGrow={fill() ? 1 : 0}
      border
      borderStyle="rounded"
      borderColor={C.border}
      title={props.title}
      titleColor={titleColor()}
    >
      <text fg={C.muted} attributes={TextAttributes.BOLD}>
        {headerLine()}
      </text>
      <Show when={props.rows.length === 0} fallback={body}>
        <text attributes={TextAttributes.DIM}>{emptyText()}</text>
      </Show>
    </box>
  );

  // Interleave repo headers with their rows, then window over the combined line
  // list so headers count toward the height budget. selDisplay is where the
  // selected row lands in that combined list.
  type Item =
    | { kind: "header"; label: string; key: string }
    | { kind: "row"; row: Row; idx: number };

  // The interleaved-and-windowed view, recomputed REACTIVELY whenever the rows
  // or the selection change — this is what makes the catalog update as models
  // load and scroll as the cursor moves (a plain function called once would
  // freeze the window at first render).
  const groupedView = createMemo(() => {
    const items: Item[] = [];
    let prevLabel: string | null = null;
    props.rows.forEach((row, idx) => {
      const label = repoLabel(row);
      if (label !== prevLabel) {
        items.push({ kind: "header", label, key: `h:${label}` });
        prevLabel = label;
      }
      items.push({ kind: "row", row, idx });
    });
    const selDisplay =
      props.selectedIndex < 0
        ? -1
        : items.findIndex((it) => it.kind === "row" && it.idx === props.selectedIndex);

    // Reserve two lines when scrolling: one for the scroll indicator, one for a
    // sticky header repeating the group of the top row when it scrolled off.
    const maxRows = props.maxRows;
    const scrolling = maxRows != null && items.length > maxRows;
    const capacity = scrolling ? Math.max(1, maxRows - 2) : items.length;
    const { start, end } = scrolling
      ? windowSlice(items.length, selDisplay, capacity)
      : { start: 0, end: items.length };
    const visible = items.slice(start, end);

    let sticky: string | null = null;
    if (scrolling && visible[0]?.kind === "row") {
      for (let i = start; i >= 0; i--) {
        const it = items[i];
        if (it?.kind === "header") {
          sticky = it.label;
          break;
        }
      }
    }
    const hiddenAbove = items.slice(0, start).filter((it) => it.kind === "row").length;
    const hiddenBelow = items.slice(end).filter((it) => it.kind === "row").length;
    return { visible, sticky, hiddenAbove, hiddenBelow, scrolling };
  });

  const moreLine = (hiddenAbove: number, hiddenBelow: number): string =>
    (hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : "") +
    (hiddenAbove > 0 && hiddenBelow > 0 ? "   " : "") +
    (hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : "");

  const groupedBody = (): JSX.Element => (
    <>
      <Show when={groupedView().sticky}>
        <text fg={C.group} attributes={TextAttributes.BOLD | TextAttributes.DIM}>
          {clamp(groupedView().sticky!)}
        </text>
      </Show>
      <For each={groupedView().visible}>
        {(it) =>
          it.kind === "header" ? (
            <text fg={C.group} attributes={TextAttributes.BOLD}>
              {clamp(it.label)}
            </text>
          ) : (
            renderRow(it.row, it.idx)
          )
        }
      </For>
      <Show when={groupedView().scrolling}>
        <text attributes={TextAttributes.DIM}>
          {moreLine(groupedView().hiddenAbove, groupedView().hiddenBelow)}
        </text>
      </Show>
    </>
  );

  // Flat (ungrouped) rendering: window the rows directly, reserving one line for
  // the scroll indicator. The selected row stays in view (see windowSlice).
  const flatView = createMemo(() => {
    const maxRows = props.maxRows;
    const scrolling = maxRows != null && props.rows.length > maxRows;
    const { start, end } = scrolling
      ? windowSlice(props.rows.length, props.selectedIndex, Math.max(1, maxRows - 1))
      : { start: 0, end: props.rows.length };
    return {
      visible: props.rows.slice(start, end),
      start,
      scrolling,
      hiddenAbove: start,
      hiddenBelow: props.rows.length - end,
    };
  });

  const flatBody = (): JSX.Element => (
    <>
      <For each={flatView().visible}>{(row, i) => renderRow(row, flatView().start + i())}</For>
      <Show when={flatView().scrolling}>
        <text attributes={TextAttributes.DIM}>
          {moreLine(flatView().hiddenAbove, flatView().hiddenBelow)}
        </text>
      </Show>
    </>
  );

  return chrome(grouped() ? groupedBody() : flatBody());
}
