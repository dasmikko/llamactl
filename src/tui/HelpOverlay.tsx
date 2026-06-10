/**
 * Modal listing the keybindings. Esc (or ?) closes it; the app gates this
 * component behind mode === "help", so it only needs to render the list.
 */

import React from "react";
import { Box, Text } from "ink";

interface Binding {
  keys: string;
  desc: string;
}

const BINDINGS: Binding[] = [
  { keys: "j / ↓", desc: "move selection down" },
  { keys: "k / ↑", desc: "move selection up" },
  { keys: "g / G", desc: "jump to top / bottom" },
  { keys: "Enter", desc: "start the selected model" },
  { keys: "Ctrl+S", desc: "stop a running instance (confirm with Ctrl+S or y)" },
  { keys: "i", desc: "show full details about the selected model" },
  { keys: "f", desc: "toggle favorite (★ — keeps the model at the top of the list)" },
  { keys: "e", desc: "edit launch flags in place (the model's, or the selected profile's)" },
  { keys: "n", desc: "add another profile (a testing variant) under the selected model" },
  { keys: "d", desc: "delete the selected profile / clear the model's flags (press again / y to confirm)" },
  { keys: "D", desc: "delete the model file(s) from disk (confirm; stop it first)" },
  { keys: "l", desc: "view logs of a running row" },
  { keys: "o", desc: "open a running instance's web UI in the browser" },
  { keys: "p", desc: "pull a model from Hugging Face (search / browse)" },
  { keys: "/", desc: "filter the list" },
  { keys: "?", desc: "toggle this help" },
  { keys: "Ctrl+R", desc: "restart the daemon (stops all instances; confirm with Ctrl+R or y)" },
  { keys: "Esc", desc: "close a modal / clear filter" },
  { keys: "q / Ctrl-C", desc: "quit (the daemon keeps running)" },
];

export function HelpOverlay(): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
    >
      <Text bold>Keybindings</Text>
      <Box flexDirection="column" marginTop={1}>
        {BINDINGS.map((b) => (
          <Box key={b.keys}>
            <Box width={14}>
              <Text color="cyan">{b.keys}</Text>
            </Box>
            <Text>{b.desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc or ? to close</Text>
      </Box>
    </Box>
  );
}
