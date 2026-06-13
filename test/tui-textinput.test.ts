import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { editText } from "../src/tui/textinput.tsx";

/** A Key with everything false; spread to set the bits a test cares about. */
const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

const key = (over: Partial<Key>): Key => ({ ...NONE, ...over });

describe("editText", () => {
  test("inserts a character at the cursor", () => {
    expect(editText({ value: "ac", cursor: 1 }, "b", NONE)).toEqual({
      value: "abc",
      cursor: 2,
    });
  });

  test("appends at end of line", () => {
    expect(editText({ value: "ab", cursor: 2 }, "c", NONE)).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("←/→ move the cursor and clamp at the bounds", () => {
    expect(editText({ value: "abc", cursor: 2 }, "", key({ leftArrow: true }))).toEqual({
      value: "abc",
      cursor: 1,
    });
    expect(editText({ value: "abc", cursor: 0 }, "", key({ leftArrow: true }))).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(editText({ value: "abc", cursor: 3 }, "", key({ rightArrow: true }))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("Ctrl-A / Ctrl-E jump to start / end", () => {
    expect(editText({ value: "abc", cursor: 1 }, "a", key({ ctrl: true }))).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(editText({ value: "abc", cursor: 1 }, "e", key({ ctrl: true }))).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  test("backspace deletes the character before the cursor", () => {
    expect(editText({ value: "abc", cursor: 2 }, "", key({ backspace: true }))).toEqual({
      value: "ac",
      cursor: 1,
    });
    // Delete is treated the same (Ink reports Backspace as either).
    expect(editText({ value: "abc", cursor: 3 }, "", key({ delete: true }))).toEqual({
      value: "ab",
      cursor: 2,
    });
  });

  test("backspace at the start is a no-op (returns null)", () => {
    expect(editText({ value: "abc", cursor: 0 }, "", key({ backspace: true }))).toBeNull();
  });

  test("non-editing keys return null", () => {
    expect(editText({ value: "abc", cursor: 1 }, "", key({ tab: true }))).toBeNull();
    expect(editText({ value: "abc", cursor: 1 }, "", key({ return: true }))).toBeNull();
  });

  test("accept filter swallows rejected input", () => {
    const digits = (t: string) => /^[0-9]+$/.test(t);
    expect(editText({ value: "12", cursor: 2 }, "x", NONE, digits)).toBeNull();
    expect(editText({ value: "12", cursor: 2 }, "3", NONE, digits)).toEqual({
      value: "123",
      cursor: 3,
    });
  });

  test("clamps an out-of-range cursor before editing", () => {
    expect(editText({ value: "ab", cursor: 9 }, "c", NONE)).toEqual({
      value: "abc",
      cursor: 3,
    });
  });
});
