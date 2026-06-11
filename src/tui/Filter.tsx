/**
 * A one-line `/` filter input. Hand-rolled controlled input via useInput.
 * Enter/Esc are handled by the parent (which owns mode), but Esc here clears
 * back to the table and Enter confirms; both delegate via callbacks.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { ShortcutBar } from "./ShortcutBar.tsx";

export interface FilterProps {
  value: string;
  onChange: (next: string) => void;
  /** Confirm the filter and return to table mode. */
  onSubmit: () => void;
  /** Cancel: clear the filter and return to table mode. */
  onCancel: () => void;
}

export function Filter({
  value,
  onChange,
  onSubmit,
  onCancel,
}: FilterProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  return (
    <Box>
      <Text color="cyan">/ </Text>
      <Text>
        {value}
        <Text inverse> </Text>
      </Text>
      <Text>{"  "}</Text>
      <ShortcutBar
        items={[
          { key: "Enter", desc: "confirm" },
          { key: "Esc", desc: "clear" },
        ]}
      />
    </Box>
  );
}
