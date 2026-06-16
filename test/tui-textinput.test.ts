import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { editText } from "../src/tui/textinput.tsx";

/**
 * A minimal opentui KeyEvent for the fields editText reads (name, ctrl, meta,
 * sequence). Cast to KeyEvent — the renderer fills the rest at runtime.
 */
const key = (over: Partial<KeyEvent>): KeyEvent =>
  ({ name: "", ctrl: false, meta: false, shift: false, sequence: "", ...over }) as KeyEvent;

/** A printable character keypress (name + sequence are the char). */
const ch = (c: string): KeyEvent => key({ name: c, sequence: c });

describe("editText", () => {
  test("inserts a character at the cursor", () => {
    expect(editText({ value: "ac", cursor: 1 }, ch("b"))).toEqual({
      value: "abc",
      cursor: 2,
    });
  });

  test("appends at end of line", () => {
    expect(editText({ value: "ab", cursor: 2 }, ch("c"))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("←/→ move the cursor and clamp at the bounds", () => {
    expect(editText({ value: "abc", cursor: 2 }, key({ name: "left" }))).toEqual({
      value: "abc",
      cursor: 1,
    });
    expect(editText({ value: "abc", cursor: 0 }, key({ name: "left" }))).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(editText({ value: "abc", cursor: 3 }, key({ name: "right" }))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("Ctrl-A / Ctrl-E jump to start / end", () => {
    expect(editText({ value: "abc", cursor: 1 }, key({ name: "a", ctrl: true }))).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(editText({ value: "abc", cursor: 1 }, key({ name: "e", ctrl: true }))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("backspace deletes the character before the cursor", () => {
    expect(editText({ value: "abc", cursor: 2 }, key({ name: "backspace" }))).toEqual({
      value: "ac",
      cursor: 1,
    });
    // Delete is treated the same (terminals report Backspace as either).
    expect(editText({ value: "abc", cursor: 3 }, key({ name: "delete" }))).toEqual({
      value: "ab",
      cursor: 2,
    });
  });

  test("backspace at the start is a no-op (returns null)", () => {
    expect(editText({ value: "abc", cursor: 0 }, key({ name: "backspace" }))).toBeNull();
  });

  test("non-editing keys return null", () => {
    expect(editText({ value: "abc", cursor: 1 }, key({ name: "tab", sequence: "\t" }))).toBeNull();
    expect(editText({ value: "abc", cursor: 1 }, key({ name: "return", sequence: "\r" }))).toBeNull();
  });

  test("accept filter swallows rejected input", () => {
    const digits = (t: string) => /^[0-9]+$/.test(t);
    expect(editText({ value: "12", cursor: 2 }, ch("x"), digits)).toBeNull();
    expect(editText({ value: "12", cursor: 2 }, ch("3"), digits)).toEqual({
      value: "123",
      cursor: 3,
    });
  });

  test("clamps an out-of-range cursor before editing", () => {
    expect(editText({ value: "ab", cursor: 9 }, ch("c"))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });
});
