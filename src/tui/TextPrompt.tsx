/**
 * A minimal single-line text prompt modal. Hand-rolled controlled input via
 * useInput (no extra deps), matching the BuildForm/Filter idioms: typing edits
 * the value, Enter submits a non-empty value, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface TextPromptProps {
  title: string;
  initialValue?: string;
  /** Submit the (trimmed-non-empty) value. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function TextPrompt({
  title,
  initialValue = "",
  onSubmit,
  onCancel,
}: TextPromptProps): React.ReactElement {
  const [value, setValue] = useState(initialValue);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.trim() !== "") onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((s) => s + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Box marginTop={1}>
        <Text inverse wrap="truncate-start">
          {value || " "}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter save · Esc cancel</Text>
      </Box>
    </Box>
  );
}
