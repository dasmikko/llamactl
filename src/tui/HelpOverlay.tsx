/**
 * Modal listing the keybindings. Esc (or ?) closes it; the app gates this
 * component behind mode === "help", so it only needs to render the list.
 */

import { For, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { C } from "./theme.ts";

interface Binding {
  keys: string;
  desc: string;
}

const BINDINGS: Binding[] = [
  { keys: "j / ↓", desc: "move selection down" },
  { keys: "k / ↑", desc: "move selection up" },
  { keys: "g / G", desc: "jump to top / bottom" },
  { keys: "Enter", desc: "launch — pick Default, a saved profile, or create a new one" },
  { keys: "Ctrl+S", desc: "stop a running instance (confirm with Ctrl+S or y)" },
  { keys: "i", desc: "show full details about the selected model" },
  { keys: "f", desc: "toggle favorite (★ — keeps the model at the top of the list)" },
  { keys: "e", desc: "manage profiles for the selected model (switch / create / edit / delete)" },
  { keys: "n", desc: "create a new profile for the selected model" },
  { keys: "d", desc: "delete a standalone (orphan) profile row (press again / y to confirm)" },
  { keys: "D", desc: "delete the model file(s) from disk (confirm; stop it first)" },
  { keys: "l", desc: "view logs of a running row" },
  { keys: "o", desc: "open a running instance's web UI in the browser" },
  { keys: "p", desc: "pull a model from Hugging Face (search / browse)" },
  { keys: "P", desc: "manage downloads (r retry/resume · c cancel · d dismiss)" },
  { keys: "I", desc: "view managed llama.cpp installs (Enter set active/view log · l log · r rename · u update+recompile · c cancel · d remove · n new)" },
  { keys: "B", desc: "build a managed llama.cpp install from source" },
  { keys: "/", desc: "filter the list" },
  { keys: "?", desc: "toggle this help" },
  { keys: "Ctrl+R", desc: "restart the daemon (stops all instances; confirm with Ctrl+R or y)" },
  { keys: "Esc", desc: "close a modal / clear filter" },
  { keys: "q / Ctrl-C", desc: "quit (the daemon keeps running)" },
];

export function HelpOverlay(): JSX.Element {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
    >
      <text fg={C.text} attributes={TextAttributes.BOLD}>Keybindings</text>
      <box flexDirection="column" marginTop={1}>
        <For each={BINDINGS}>
          {(b) => (
            <box flexDirection="row">
              <box width={14}>
                <text fg={C.accent}>{b.keys}</text>
              </box>
              <text fg={C.text}>{b.desc}</text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" marginTop={1}>
        <text fg={C.text} attributes={TextAttributes.DIM}>Esc or ? to close</text>
      </box>
    </box>
  );
}
