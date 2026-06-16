/**
 * Shared single-line text-editing primitives for the hand-rolled inputs across
 * the TUI (FlagEditor, BuildForm, TextPrompt, Filter, HfBrowser) — so they all
 * support an actual cursor (←/→, Ctrl-A/E to jump, insert/backspace anywhere in
 * the string) and render a clean block cursor. `editText` mutates a
 * {value, cursor} pair from an opentui key event; `CursorText` renders that pair
 * with the cursor cell highlighted.
 */

import { Show } from "solid-js";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import { C } from "./theme.ts";

export interface TextEdit {
  value: string;
  cursor: number;
}

/** True for a single printable character (not a control / escape sequence). */
function isPrintable(s: string): boolean {
  return s.length >= 1 && ![...s].some((c) => c.codePointAt(0)! < 0x20 || c === "\x7f");
}

/**
 * Apply an opentui key event to a (value, cursor) state. Handles cursor movement
 * (←/→, Ctrl-A/Ctrl-E for start/end), backward delete, and inserting printable
 * input at the cursor. Returns the next state, or null when the key isn't a
 * text-editing key (or is a no-op) so the caller can ignore it — Tab/Enter/Esc
 * and field navigation are the caller's to handle before calling this.
 *
 * `accept` optionally filters inserted text (e.g. digits only); rejected input
 * is swallowed (returns null) so it can't fall through to other handlers.
 */
export function editText(
  state: TextEdit,
  key: KeyEvent,
  accept?: (text: string) => boolean,
): TextEdit | null {
  const { value } = state;
  const cursor = Math.max(0, Math.min(state.cursor, value.length));

  if (key.name === "left") return { value, cursor: Math.max(0, cursor - 1) };
  if (key.name === "right") return { value, cursor: Math.min(value.length, cursor + 1) };
  // Ctrl-A / Ctrl-E jump to start / end (readline-style Home/End).
  if (key.ctrl && key.name === "a") return { value, cursor: 0 };
  if (key.ctrl && key.name === "e") return { value, cursor: value.length };

  // Backspace and Delete both delete backward: terminals report the Backspace
  // key as one or the other and we can't reliably tell them apart.
  if (key.name === "backspace" || key.name === "delete") {
    if (cursor === 0) return null;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }

  // Insert printable input at the cursor, honouring the optional filter.
  const input = key.sequence;
  if (input && !key.ctrl && !key.meta && isPrintable(input)) {
    if (accept && !accept(input)) return null;
    return {
      value: value.slice(0, cursor) + input + value.slice(cursor),
      cursor: cursor + input.length,
    };
  }

  return null;
}

export interface CursorTextProps {
  value: string;
  cursor: number;
  focused: boolean;
  /** Dim hint rendered in place of an empty value when the field isn't focused. */
  placeholder?: string;
  /**
   * Columns the value may occupy on its single line. When set, the text
   * horizontally scrolls to keep the cursor visible: it never wraps to a new
   * line and never shows a truncation "…". Omit only when the value owns a
   * full, unconstrained line of its own.
   */
  width?: number;
}

/**
 * Render a single-line value with a block cursor over the character at `cursor`
 * when focused. The cursor is a real reverse-video cell (a sibling <text> with
 * the INVERSE attribute, not embedded ANSI — opentui renders its own attributes,
 * not raw escapes). Unfocused, it renders the plain value, or a dim placeholder
 * when empty. With `width`, the value horizontally scrolls within that many
 * columns, keeping the cursor visible.
 */
export function CursorText(props: CursorTextProps) {
  // Tolerate an undefined value (an unset field) — treat it as empty.
  const val = (): string => props.value ?? "";
  const clampCursor = (): number => Math.max(0, Math.min(props.cursor, val().length));

  // The (head, cursorChar, tail) split for the focused block cursor, honoring
  // the optional horizontal-scroll window.
  const parts = (): { head: string; at: string; tail: string } => {
    const value = val();
    const c = clampCursor();
    if (props.width == null) {
      return { head: value.slice(0, c), at: value.slice(c, c + 1) || " ", tail: value.slice(c + 1) };
    }
    // Bounded: a width-column window anchored toward the right edge so typing at
    // the end keeps the tail visible and the head scrolls in as the cursor moves.
    const w = Math.max(1, props.width);
    const start = Math.max(0, c - (w - 1));
    return {
      head: value.slice(start, c),
      at: value.slice(c, c + 1) || " ",
      tail: value.slice(c + 1, start + w),
    };
  };

  // Unfocused tail-visible slice (no wrap, no "…").
  const shown = (): string => {
    const value = val();
    return props.width != null && value.length > props.width
      ? value.slice(value.length - props.width)
      : value;
  };

  return (
    <Show
      when={props.focused}
      fallback={
        <Show
          when={props.value === "" && props.placeholder !== undefined}
          fallback={<text fg={C.text}>{shown()}</text>}
        >
          <text fg={C.text} attributes={TextAttributes.DIM}>{props.placeholder}</text>
        </Show>
      }
    >
      <box flexDirection="row">
        <text fg={C.text}>{parts().head}</text>
        <text fg={C.text} attributes={TextAttributes.INVERSE}>{parts().at}</text>
        <text fg={C.text}>{parts().tail}</text>
      </box>
    </Show>
  );
}
