/**
 * Modal that tails a running model's log file. Reads the whole file with
 * Bun.file().text(), shows the last N lines, and refreshes on an interval.
 * Esc closes. Missing/unreadable files render a friendly notice.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

export interface LogViewerProps {
  logPath: string;
  title: string;
  onClose: () => void;
}

const TAIL_LINES = 200;
const REFRESH_MS = 1000;

export function LogViewer({
  logPath,
  title,
  onClose,
}: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>("loading…");

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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Logs · {title}</Text>
      <Text dimColor>{logPath}</Text>
      <Box flexDirection="column" marginTop={1}>
        {notice ? <Text dimColor>{notice}</Text> : null}
        {lines.map((line, i) => (
          // Log lines have no stable id; index is fine for an append-only tail.
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc close</Text>
      </Box>
    </Box>
  );
}
