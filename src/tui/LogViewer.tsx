/**
 * Modal that tails a running model's log file. Reads the whole file with
 * Bun.file().text(), shows the last N lines, and refreshes on an interval.
 * Esc closes. Missing/unreadable files render a friendly notice.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";

export interface LogViewerProps {
  logPath: string;
  title: string;
  onClose: () => void;
}

const TAIL_LINES = 500;
const REFRESH_MS = 1000;
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
  const { stdout } = useStdout();

  useInput((_input, key) => {
    if (key.escape) onClose();
  });

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

  // Only render as many of the most-recent lines as fit the terminal height,
  // so the modal can't grow past the screen on a noisy update.
  const maxRows = Math.max(3, (stdout.rows || 24) - CHROME_ROWS);
  const visible = lines.slice(-maxRows);

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
          <Text key={i} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Esc close{lines.length > visible.length ? `  ·  showing last ${visible.length} of ${lines.length}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
