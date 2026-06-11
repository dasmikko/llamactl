/**
 * Modal that tails a running model's log file. Reads the whole file with
 * Bun.file().text(), shows the last N lines, and refreshes on an interval.
 * Esc closes. Missing/unreadable files render a friendly notice.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";

export interface LogViewerProps {
  logPath: string;
  title: string;
  onClose: () => void;
}

const TAIL_LINES = 500;
const REFRESH_MS = 1000;

/** ANSI/VT escape sequences (colors, cursor moves) emitted by build tools. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Make one captured log line safe to render in the TUI. Build tools (cmake,
 * ninja, make) redraw progress in place with carriage returns and color with
 * ANSI escapes; an embedded `\r` would yank the terminal cursor to column 0
 * mid-render and corrupt the layout. Strip ANSI, drop a trailing CRLF `\r`, then
 * collapse `\r` progress redraws to the final visible segment — what a terminal
 * would leave on screen — and remove any remaining control characters.
 */
export function sanitizeLogLine(line: string): string {
  const noAnsi = line.replace(ANSI_RE, "").replace(/\r$/, "");
  const lastCr = noAnsi.lastIndexOf("\r");
  const visible = lastCr >= 0 ? noAnsi.slice(lastCr + 1) : noAnsi;
  return visible.replace(/[\x00-\x08\x0b-\x1f]/g, "");
}
/**
 * Rows of fixed chrome above/around the scrollback (resource header + this
 * modal's border/title/path/footer). Subtracted from the terminal height so the
 * log never renders taller than the screen and breaks the full-screen layout.
 */
const CHROME_ROWS = 14;

export function LogViewer({
  logPath,
  title,
  onClose,
}: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>("loading…");
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = at bottom
  const [followMode, setFollowMode] = useState(true);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const { stdout } = useStdout();

  useInput((_input, key) => {
    if (key.escape) onClose();

    const currentLines = linesRef.current;
    const maxRows = Math.max(3, (stdout.rows || 24) - CHROME_ROWS);
    const maxScrollOffset = Math.max(0, currentLines.length - maxRows);

    if (key.upArrow || key.leftArrow) {
      setScrollOffset((prev) => Math.min(prev + 5, maxScrollOffset));
      setFollowMode(false);
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setScrollOffset((prev) => Math.max(prev - 5, 0));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + maxRows, maxScrollOffset));
      setFollowMode(false);
      return;
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(prev - maxRows, 0));
      return;
    }
    if (_input === "f" || _input === "F") {
      setScrollOffset(0);
      setFollowMode(true);
      return;
    }
    if (_input === " ") {
      setFollowMode((prev) => {
        const next = !prev;
        if (next) setScrollOffset(0);
        return next;
      });
      return;
    }
  });

  // Auto-follow when new lines arrive while in follow mode.
  useEffect(() => {
    if (followMode && lines.length > 0) {
      setScrollOffset(0);
    }
  }, [lines.length]);

  useEffect(() => {
    let active = true;

    const read = async (): Promise<void> => {
      try {
        const file = Bun.file(logPath);
        if (!(await file.exists())) {
          if (active) {
            setNotice("log file not found yet");
            setLines([]);
          }
          return;
        }
        const text = await file.text();
        if (!active) return;
        const all = text.split("\n");
        // Drop a trailing empty line from a final newline.
        if (all.length > 0 && all[all.length - 1] === "") all.pop();
        setLines(all.slice(-TAIL_LINES));
        setNotice(all.length === 0 ? "(empty log)" : null);
      } catch (e) {
        if (active) {
          setNotice(
            `could not read log: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    };

    void read();
    const interval = setInterval(() => void read(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [logPath]);

  const maxRows = Math.max(3, (stdout.rows || 24) - CHROME_ROWS);
  const visibleCount = Math.min(maxRows, lines.length);

  // Compute the slice to display based on scrollOffset.
  // scrollOffset = 0 means show the last maxRows (follow mode).
  // scrollOffset > 0 means skip that many lines from the end.
  const startIdx = Math.max(0, lines.length - visibleCount - scrollOffset);
  const visible = lines.slice(startIdx, startIdx + visibleCount);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Logs · {title}</Text>
      <Text dimColor wrap="truncate">
        {logPath}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {notice ? <Text dimColor>{notice}</Text> : null}
        {visible.map((line, i) => (
          // Log lines have no stable id; index is fine for an append-only tail.
          // wrap="truncate" keeps each line to one row so height stays bounded.
          // sanitize strips carriage returns / ANSI so build progress output
          // doesn't corrupt the terminal layout.
          <Text key={i} wrap="truncate">
            {sanitizeLogLine(line)}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        {notice ? null : (
          <Text dimColor>
            {followMode ? (
              <>
                <Text color="green">FOLLOW</Text>
                {" "}· Esc close · Space unfollow · ↑↓ scroll · Page Up/Down page · F follow
              </>
            ) : (
              <>
                <Text color="yellow">SCROLLED UP</Text>
                {" "}· {lines.length - visibleCount - scrollOffset + 1}–{lines.length - scrollOffset} of {lines.length}
                {" "}· Space follow · Esc close
              </>
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}
