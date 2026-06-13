/**
 * A one-line `/` filter input. Hand-rolled controlled input via useInput.
 * Enter/Esc are handled by the parent (which owns mode), but Esc here clears
 * back to the table and Enter confirms; both delegate via callbacks.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";

export interface FilterProps {
  value: string;
  onChange: (next: string) => void;
  /** Confirm the filter and return to table mode. */
  onSubmit: () => void;
  /** Cancel: clear the filter and return to table mode. */
  onCancel: () => void;
  /** Terminal width, used to bound the input so it scrolls, not wraps. */
  columns: number;
}

export function Filter({
  value,
  onChange,
  onSubmit,
  onCancel,
  columns,
}: FilterProps): React.ReactElement {
  // The parent owns `value`; the cursor is a view concern tracked locally. The
  // component remounts each time filter mode opens, so it starts at end-of-text.
  const [cursor, setCursor] = useState(value.length);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit();
      return;
    }
    const next = editText({ value, cursor }, input, key);
    if (next) {
      onChange(next.value);
      setCursor(next.cursor);
    }
  });

  return (
    <Box>
      <Text color="cyan">/ </Text>
      {/* Bound the value so it scrolls instead of wrapping and shoving the
          shortcut bar (which truncates) onto a second line. Reserve ~30 cols for
          the "/ " prefix, the gap, and the shortcut bar. */}
      <CursorText value={value} cursor={cursor} focused width={Math.max(8, columns - 30)} />
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
