/**
 * Output rendering. Honors the `--json` contract: when JSON mode is on, the
 * ONLY thing written to stdout is a single machine-readable JSON document —
 * no color, no spinners, no preamble. On a TTY we render a padded table; when
 * piped (non-TTY) we emit TSV.
 */

export interface OutputMode {
  /** True when --json was passed: emit JSON and nothing else. */
  json: boolean;
  /** True when stdout is a TTY (padded table); false → TSV. */
  tty: boolean;
}

export function detectOutputMode(json: boolean): OutputMode {
  return { json, tty: Boolean(process.stdout.isTTY) };
}

/** Emit a JSON document followed by a newline (the only stdout write in --json mode). */
export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** Emit a plain human line (suppressed in --json mode by callers). */
export function emitLine(line = ""): void {
  process.stdout.write(line + "\n");
}

/** Emit an error line to stderr. */
export function emitError(line: string): void {
  process.stderr.write(line + "\n");
}

export interface Column<T> {
  header: string;
  /** Cell value as a string. */
  get: (row: T) => string;
  /** Right-align (e.g. numbers). */
  alignRight?: boolean;
}

/**
 * Render rows either as a padded table (TTY) or TSV (piped). Returns the full
 * string; caller decides where to write it.
 */
export function renderTable<T>(rows: T[], columns: Column<T>[], mode: OutputMode): string {
  if (!mode.tty) {
    // TSV: header row + tab-separated values, no padding, no color.
    const lines = [columns.map((c) => c.header).join("\t")];
    for (const row of rows) lines.push(columns.map((c) => c.get(row)).join("\t"));
    return lines.join("\n");
  }

  const widths = columns.map((c, ci) => {
    let w = c.header.length;
    for (const row of rows) w = Math.max(w, columns[ci]!.get(row).length);
    return w;
  });

  const pad = (s: string, w: number, right: boolean): string =>
    right ? s.padStart(w) : s.padEnd(w);

  const headerLine = columns
    .map((c, ci) => pad(c.header, widths[ci]!, false))
    .join("  ")
    .trimEnd();
  const lines = [headerLine];
  for (const row of rows) {
    lines.push(
      columns
        .map((c, ci) => pad(c.get(row), widths[ci]!, c.alignRight ?? false))
        .join("  ")
        .trimEnd(),
    );
  }
  return lines.join("\n");
}

/** Human-readable byte size, e.g. 4.1 GB. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const fixed = u === 0 ? String(n) : n.toFixed(1);
  return `${fixed} ${units[u]}`;
}

/** Human-readable duration from a start epoch ms to now. */
export function humanUptime(startedAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}
