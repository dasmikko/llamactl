/**
 * Shared single-line text-editing primitives for the hand-rolled inputs across
 * the TUI (FlagEditor, BuildForm, TextPrompt, Filter, HfBrowser) — so they all
 * support an actual cursor (←/→, Ctrl-A/E to jump, insert/backspace anywhere in
 * the string) and render a clean block cursor instead of inverting the whole
 * value. `editText` mutates a {value, cursor} pair from a key event; `CursorText`
 * renders that pair with the cursor cell highlighted.
 */

import React from "react";
import { Text } from "ink";
import type { Key } from "ink";

export interface TextEdit {
  value: string;
  cursor: number;
}

/**
 * Apply a key event to a (value, cursor) state. Handles cursor movement (←/→,
 * Ctrl-A/Ctrl-E for start/end), backward delete, and inserting printable input
 * at the cursor. Returns the next state, or null when the key isn't a
 * text-editing key (or is a no-op) so the caller can ignore it — Tab/Enter/Esc
 * and field navigation are the caller's to handle before calling this.
 *
 * `accept` optionally filters inserted text (e.g. digits only); rejected input
 * is swallowed (returns null) so it can't fall through to other handlers.
 */
export function editText(
  state: TextEdit,
  input: string,
  key: Key,
  accept?: (text: string) => boolean,
): TextEdit | null {
  const { value } = state;
  const cursor = Math.max(0, Math.min(state.cursor, value.length));

  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  // Ctrl-A / Ctrl-E jump to start / end (readline-style Home/End).
  if (key.ctrl && input === "a") return { value, cursor: 0 };
  if (key.ctrl && input === "e") return { value, cursor: value.length };

  // Backspace and Delete both delete backward: terminals/Ink report the
  // Backspace key as one or the other and we can't reliably tell them apart.
  if (key.backspace || key.delete) {
    if (cursor === 0) return null;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }

  // Insert printable input at the cursor, honouring the optional filter.
  if (input && !key.ctrl && !key.meta) {
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
   * line and never shows a truncation "…" — the two failure modes that bite a
   * narrow terminal. Pass a value a column or two under the real space so a
   * full-width window can't spill and wrap. Omit only when the value owns a
   * full, unconstrained line of its own.
   */
  width?: number;
}

// Reverse-video on/off, embedded directly in the value STRING (not a nested
// `<Text inverse>`). A block cursor needs to sit *on* the character at the
// cursor, which means inverting one cell — but a nested styled cell makes Ink
// reuse a stale measured width when the content changes, allocating the line one
// column too few so the trailing cell wraps onto the next row (the cursor jumps a
// line below the focused field). Embedding the codes keeps it a single flat
// string: Ink measures string width ANSI-aware, so the width is recomputed
// correctly every render and nothing wraps.
const INV = "\x1b[7m";
const RST = "\x1b[27m";

/** Draw a reverse-video block over `at` (a space at end-of-line where there is no char). */
function blockOver(at: string): string {
  return INV + (at === "" ? " " : at) + RST;
}

/**
 * Render a single-line value with a block cursor over the character at `cursor`
 * when focused (a reverse-video block; a blank block at end-of-line). Unfocused,
 * it renders the plain value, or a dim placeholder when empty. With `width`, the
 * value horizontally scrolls within that many columns, keeping the cursor visible.
 */
export function CursorText({
  value,
  cursor,
  focused,
  placeholder,
  width,
}: CursorTextProps): React.ReactElement {
  if (!focused) {
    if (value === "" && placeholder !== undefined) {
      return <Text dimColor>{placeholder}</Text>;
    }
    // Unfocused: keep the tail visible within the column (no wrap, no "…").
    const shown =
      width != null && value.length > width ? value.slice(value.length - width) : value;
    return <Text>{shown}</Text>;
  }

  const len = value.length;
  const c = Math.max(0, Math.min(cursor, len));

  // Unbounded: the whole value with the cursor block over the cursor character.
  if (width == null) {
    return <Text>{value.slice(0, c) + blockOver(value.slice(c, c + 1)) + value.slice(c + 1)}</Text>;
  }

  // Bounded: a horizontal-scroll window of `width` columns that holds the cursor.
  // It is anchored toward the right edge, so typing at the end keeps the tail
  // visible and the head scrolls in as the cursor moves left into it. The cursor
  // cell plus the chars before it never exceed `width`, so the line can't wrap.
  const w = Math.max(1, width);
  const start = Math.max(0, c - (w - 1));
  const head = value.slice(start, c);
  const tail = value.slice(c + 1, start + w);
  return <Text>{head + blockOver(value.slice(c, c + 1)) + tail}</Text>;
}
