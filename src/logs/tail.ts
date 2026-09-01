/**
 * Reading a child's log file for display. Both the TUI's LogViewer and the web
 * server tail the same files, so the sanitizer and the tail read live here
 * rather than inside a `.tsx` — importing that from a headless path would drag
 * Solid/opentui in with it.
 */

/** ANSI/VT escape sequences (colors, cursor moves) emitted by build tools. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Make one captured log line safe to render. Build tools (cmake, ninja, make)
 * redraw progress in place with carriage returns and color with ANSI escapes;
 * an embedded `\r` would yank the terminal cursor to column 0 mid-render and
 * corrupt the layout. Strip ANSI, drop a trailing CRLF `\r`, then collapse `\r`
 * progress redraws to the final visible segment — what a terminal would leave
 * on screen — and remove any remaining control characters.
 */
export function sanitizeLogLine(line: string): string {
  const noAnsi = line.replace(ANSI_RE, "").replace(/\r$/, "");
  const lastCr = noAnsi.lastIndexOf("\r");
  const visible = lastCr >= 0 ? noAnsi.slice(lastCr + 1) : noAnsi;
  return visible.replace(/[\x00-\x08\x0b-\x1f]/g, "");
}

/** The tail of a log file, plus enough context to render "showing N of M". */
export interface LogTail {
  /** The last `maxLines` lines, sanitized. */
  lines: string[];
  /** Total lines in the file (≥ `lines.length`). */
  total: number;
  /** True when the file does not exist yet — a just-spawned child. */
  missing: boolean;
}

/**
 * Read the last `maxLines` lines of a log file. Reads the whole file (llama
 * logs are small and the TUI already does this); a missing file is a normal
 * state, not an error, because the log appears a beat after the child spawns.
 */
export async function tailLog(path: string, maxLines: number): Promise<LogTail> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], total: 0, missing: true };
  const text = await file.text();
  const all = text.split("\n");
  // Drop the trailing empty string a final newline produces.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return {
    lines: all.slice(-maxLines).map(sanitizeLogLine),
    total: all.length,
    missing: false,
  };
}
