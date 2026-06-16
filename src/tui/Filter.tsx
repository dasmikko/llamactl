/**
 * A one-line `/` filter input. Hand-rolled controlled input via useKeyboard.
 * Enter/Esc are handled by the parent (which owns mode), but Esc here clears
 * back to the table and Enter confirms; both delegate via callbacks.
 */

import { createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";
import { C } from "./theme.ts";

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

export function Filter(props: FilterProps) {
  // The parent owns `value`; the cursor is a view concern tracked locally. The
  // component remounts each time filter mode opens, so it starts at end-of-text.
  const [cursor, setCursor] = createSignal(props.value.length);

  useKeyboard((key) => {
    if (key.name === "escape") {
      props.onCancel();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      props.onSubmit();
      return;
    }
    const next = editText({ value: props.value, cursor: cursor() }, key);
    if (next) {
      props.onChange(next.value);
      setCursor(next.cursor);
    }
  });

  return (
    <box flexDirection="row">
      <text fg={C.accent}>/ </text>
      {/* Bound the value so it scrolls instead of wrapping and shoving the
          shortcut bar (which truncates) onto a second line. Reserve ~30 cols for
          the "/ " prefix, the gap, and the shortcut bar. */}
      <CursorText
        value={props.value}
        cursor={cursor()}
        focused
        width={Math.max(8, props.columns - 30)}
      />
      <text>{"  "}</text>
      <ShortcutBar
        items={[
          { key: "Enter", desc: "confirm" },
          { key: "Esc", desc: "clear" },
        ]}
      />
    </box>
  );
}
