/**
 * A minimal single-line text prompt modal. Hand-rolled controlled input via
 * useKeyboard (no extra deps), matching the BuildForm/Filter idioms: typing
 * edits the value, Enter submits a non-empty value, Esc cancels.
 */

import { createSignal } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";
import { C } from "./theme.ts";

export interface TextPromptProps {
  title: string;
  initialValue?: string;
  /** Submit the (trimmed-non-empty) value. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Terminal width, used to bound the input so it scrolls, not wraps. */
  columns: number;
}

export function TextPrompt(props: TextPromptProps) {
  const [value, setValue] = createSignal(props.initialValue ?? "");
  const [cursor, setCursor] = createSignal((props.initialValue ?? "").length);

  useKeyboard((key) => {
    if (key.name === "escape") {
      props.onCancel();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (value().trim() !== "") props.onSubmit(value().trim());
      return;
    }
    const next = editText({ value: value(), cursor: cursor() }, key);
    if (next) {
      setValue(next.value);
      setCursor(next.cursor);
    }
  });

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.border} backgroundColor={C.surface} paddingX={1}>
      <text fg={C.accent} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <box marginTop={1}>
        <CursorText
          value={value()}
          cursor={cursor()}
          focused
          width={Math.max(8, props.columns - 4 - 1)}
        />
      </box>
      <box marginTop={1}>
        <ShortcutBar
          items={[
            { key: "Enter", desc: "save" },
            { key: "Esc", desc: "cancel" },
          ]}
        />
      </box>
    </box>
  );
}
