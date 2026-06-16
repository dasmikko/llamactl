/**
 * A one-line, context-aware footer of keyboard shortcuts. Each entry renders as
 * a bright key followed by a dim description, separated by middots. The whole
 * line is a row of sibling <text> runs (opentui has no nested-text inline runs)
 * and is clipped by the parent width rather than wrapped, so a footer never
 * reflows the fixed-height layout. Callers build the `items` list from the
 * current selection so only the shortcuts that actually apply are shown.
 */

import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { C } from "./theme.ts";

export interface Shortcut {
  /** The key(s) to press, e.g. "Enter", "Ctrl+S", "↑↓". */
  key: string;
  /** What the key does, e.g. "launch". */
  desc: string;
}

export function ShortcutBar(props: { items: Shortcut[] }) {
  return (
    <box flexDirection="row" overflow="hidden">
      <For each={props.items}>
        {(it, i) => (
          <>
            <Show when={i() > 0}>
              <text fg={C.text} attributes={TextAttributes.DIM}>{" · "}</text>
            </Show>
            <text fg={C.accent} attributes={TextAttributes.BOLD}>
              {it.key}
            </text>
            <text fg={C.muted}>{` ${it.desc}`}</text>
          </>
        )}
      </For>
    </box>
  );
}
