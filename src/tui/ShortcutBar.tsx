/**
 * A one-line, context-aware footer of keyboard shortcuts. Each entry renders as
 * a bright key followed by a dim description, separated by middots. The whole
 * line truncates rather than wraps, so a footer never reflows the fixed-height
 * layout. Callers build the `items` list from the current selection so only the
 * shortcuts that actually apply are shown.
 */

import React from "react";
import { Text } from "ink";

export interface Shortcut {
  /** The key(s) to press, e.g. "Enter", "Ctrl+S", "↑↓". */
  key: string;
  /** What the key does, e.g. "launch". */
  desc: string;
}

export function ShortcutBar({ items }: { items: Shortcut[] }): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      {items.map((it, i) => (
        <Text key={`${it.key}:${i}`}>
          {i > 0 ? <Text dimColor>{" · "}</Text> : null}
          <Text color="cyan" bold>
            {it.key}
          </Text>
          <Text dimColor>{` ${it.desc}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
