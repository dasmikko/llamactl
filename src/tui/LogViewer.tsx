/**
 * Modal that tails a running model's log file. Reads the whole file with
 * Bun.file().text(), shows the last N lines, and refreshes on an interval.
 * Esc closes. Missing/unreadable files render a friendly notice.
 */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { C } from "./theme.ts";

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

export function LogViewer(props: LogViewerProps) {
  const [lines, setLines] = createSignal<string[]>([]);
  const [notice, setNotice] = createSignal<string | null>("loading…");
  const [scrollOffset, setScrollOffset] = createSignal(0); // 0 = at bottom
  const [followMode, setFollowMode] = createSignal(true);
  const dims = useTerminalDimensions();

  useKeyboard((key) => {
    if (key.name === "escape") props.onClose();

    const currentLines = lines();
    const maxRows = Math.max(3, (dims().height || 24) - CHROME_ROWS);
    const maxScrollOffset = Math.max(0, currentLines.length - maxRows);

    if (key.name === "up" || key.name === "left") {
      setScrollOffset((prev) => Math.min(prev + 5, maxScrollOffset));
      setFollowMode(false);
      return;
    }
    if (key.name === "down" || key.name === "right") {
      setScrollOffset((prev) => Math.max(prev - 5, 0));
      return;
    }
    if (key.name === "pageup") {
      setScrollOffset((prev) => Math.min(prev + maxRows, maxScrollOffset));
      setFollowMode(false);
      return;
    }
    if (key.name === "pagedown") {
      setScrollOffset((prev) => Math.max(prev - maxRows, 0));
      return;
    }
    if (key.sequence === "f" || key.sequence === "F") {
      setScrollOffset(0);
      setFollowMode(true);
      return;
    }
    if (key.sequence === " ") {
      setFollowMode((prev) => {
        const next = !prev;
        if (next) setScrollOffset(0);
        return next;
      });
      return;
    }
  });

  // Auto-follow when new lines arrive while in follow mode.
  createEffect(() => {
    if (followMode() && lines().length > 0) {
      setScrollOffset(0);
    }
  });

  onMount(() => {
    let active = true;

    const read = async (): Promise<void> => {
      try {
        const file = Bun.file(props.logPath);
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
    onCleanup(() => {
      active = false;
      clearInterval(interval);
    });
  });

  const maxRows = () => Math.max(3, (dims().height || 24) - CHROME_ROWS);
  const visibleCount = () => Math.min(maxRows(), lines().length);

  // Compute the slice to display based on scrollOffset.
  // scrollOffset = 0 means show the last maxRows (follow mode).
  // scrollOffset > 0 means skip that many lines from the end.
  const startIdx = () => Math.max(0, lines().length - visibleCount() - scrollOffset());
  const visible = () => lines().slice(startIdx(), startIdx() + visibleCount());

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
      flexGrow={1}
    >
      <text attributes={TextAttributes.BOLD}>Logs · {props.title}</text>
      {/* wrap="truncate" dropped: parent box width bounds the line. */}
      <text attributes={TextAttributes.DIM}>{props.logPath}</text>
      <box flexDirection="column" marginTop={1}>
        <Show when={notice()}>
          <text attributes={TextAttributes.DIM}>{notice()}</text>
        </Show>
        <For each={visible()}>
          {(line) => (
            // Log lines have no stable id; index is fine for an append-only tail.
            // wrap="truncate" dropped: parent box width keeps each line to one row.
            // sanitize strips carriage returns / ANSI so build progress output
            // doesn't corrupt the terminal layout.
            <text>{sanitizeLogLine(line)}</text>
          )}
        </For>
      </box>
      <box flexDirection="row" marginTop={1}>
        <Show when={!notice()}>
          <Show
            when={followMode()}
            fallback={
              <box flexDirection="row">
                <text fg={C.warning}>SCROLLED UP{"  "}</text>
                <text attributes={TextAttributes.DIM}>
                  {lines().length - visibleCount() - scrollOffset() + 1}–{lines().length - scrollOffset()} of{" "}
                  {lines().length}
                  {"  "}
                </text>
                <ShortcutBar
                  items={[
                    { key: "Space", desc: "follow" },
                    { key: "Esc", desc: "close" },
                  ]}
                />
              </box>
            }
          >
            <box flexDirection="row">
              <text fg={C.success}>FOLLOW{"  "}</text>
              <ShortcutBar
                items={[
                  { key: "Esc", desc: "close" },
                  { key: "Space", desc: "unfollow" },
                  { key: "↑↓", desc: "scroll" },
                  { key: "PgUp/Dn", desc: "page" },
                ]}
              />
            </box>
          </Show>
        </Show>
      </box>
    </box>
  );
}
