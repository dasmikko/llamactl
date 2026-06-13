/**
 * A minimal single-line text prompt modal. Hand-rolled controlled input via
 * useInput (no extra deps), matching the BuildForm/Filter idioms: typing edits
 * the value, Enter submits a non-empty value, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";

export interface TextPromptProps {
  title: string;
  initialValue?: string;
  /** Submit the (trimmed-non-empty) value. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Terminal width, used to bound the input so it scrolls, not wraps. */
  columns: number;
}

export function TextPrompt({
  title,
  initialValue = "",
  onSubmit,
  onCancel,
  columns,
}: TextPromptProps): React.ReactElement {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.trim() !== "") onSubmit(value.trim());
      return;
    }
    const next = editText({ value, cursor }, input, key);
    if (next) {
      setValue(next.value);
      setCursor(next.cursor);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Box marginTop={1}>
        <CursorText
          value={value}
          cursor={cursor}
          focused
          width={Math.max(8, columns - 4 - 1)}
        />
      </Box>
      <Box marginTop={1}>
        <ShortcutBar
          items={[
            { key: "Enter", desc: "save" },
            { key: "Esc", desc: "cancel" },
          ]}
        />
      </Box>
    </Box>
  );
}
