/**
 * Modal form to start a managed llama.cpp build. Hand-rolled controlled inputs
 * via useInput (no extra deps), mirroring FlagEditor/HfBrowser idioms: Tab/↑/↓
 * move between fields, typing edits text fields, ←/→ adjust the backend chooser
 * and toggle keep-source, Enter submits, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BuildRequest, LlamaBackend } from "../types.ts";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";

export interface BuildFormProps {
  onSubmit: (req: BuildRequest) => void;
  onCancel: () => void;
  /** Terminal width, used to bound each value field so it scrolls, not wraps. */
  columns: number;
}

type FieldId =
  | "repo"
  | "ref"
  | "backend"
  | "name"
  | "allowUnsupported"
  | "cudaHostCompiler";
type TextFieldId = "repo" | "ref" | "name" | "cudaHostCompiler";

interface FieldDef {
  id: FieldId;
  label: string;
}

const FIELDS: FieldDef[] = [
  { id: "repo", label: "Repo URL" },
  { id: "ref", label: "Ref" },
  { id: "backend", label: "Backend" },
  { id: "name", label: "Name" },
  { id: "allowUnsupported", label: "Allow new gcc" },
  { id: "cudaHostCompiler", label: "CUDA host g++" },
];

const BACKENDS: readonly LlamaBackend[] = ["cpu", "cuda"];

function isTextField(id: FieldId): id is TextFieldId {
  return id === "repo" || id === "ref" || id === "name" || id === "cudaHostCompiler";
}

/** Default git repo offered as the placeholder hint for the Repo URL field. */
const REPO_PLACEHOLDER = "https://github.com/ggml-org/llama.cpp";

export function BuildForm({ onSubmit, onCancel, columns }: BuildFormProps): React.ReactElement {
  // Columns left for a value: terminal width less the round border + paddingX
  // (4) and the 18-wide label column; -1 keeps the scroll window under the real
  // space so it can't wrap.
  const valueWidth = Math.max(8, columns - 4 - 18 - 1);
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [cudaHostCompiler, setCudaHostCompiler] = useState("");
  // Default backend is cuda (index 1).
  const [backendIdx, setBackendIdx] = useState(1);
  const [allowUnsupported, setAllowUnsupported] = useState(false);
  const [focus, setFocus] = useState(0);
  // Cursor within the focused text field; reset to end-of-text when navigating.
  const [cursor, setCursor] = useState(0);

  const text: Record<TextFieldId, string> = { repo, ref, name, cudaHostCompiler };
  const setText: Record<TextFieldId, (fn: (s: string) => string) => void> = {
    repo: setRepo,
    ref: setRef,
    name: setName,
    cudaHostCompiler: setCudaHostCompiler,
  };

  /** On field change, put the cursor at the end of the newly-focused text field. */
  const focusField = (idx: number): void => {
    setFocus(idx);
    const f = FIELDS[idx];
    if (f && isTextField(f.id)) setCursor(text[f.id].length);
  };

  const submit = (): void => {
    // An empty repo defaults to upstream llama.cpp (the placeholder), applied
    // by the install manager — so a blank field is a valid "build upstream".
    const req: BuildRequest = {
      repo: repo.trim(),
      ref: ref.trim() === "" ? undefined : ref.trim(),
      backend: BACKENDS[backendIdx]!,
      name: name.trim() === "" ? undefined : name.trim(),
      allowUnsupportedCompiler: allowUnsupported,
      cudaHostCompiler:
        cudaHostCompiler.trim() === "" ? undefined : cudaHostCompiler.trim(),
    };
    onSubmit(req);
  };

  useInput((input, key) => {
    const field = FIELDS[focus];
    if (!field) return;

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.tab || key.downArrow) {
      focusField((focus + 1) % FIELDS.length);
      return;
    }
    if (key.upArrow) {
      focusField((focus - 1 + FIELDS.length) % FIELDS.length);
      return;
    }

    if (field.id === "backend") {
      if (key.leftArrow) {
        setBackendIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.rightArrow) {
        setBackendIdx((i) => Math.min(BACKENDS.length - 1, i + 1));
        return;
      }
      return; // ignore other keys while on the chooser
    }

    if (field.id === "allowUnsupported") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setAllowUnsupported((v) => !v);
      }
      return;
    }

    const id = field.id as TextFieldId;
    const next = editText({ value: text[id], cursor }, input, key);
    if (next) {
      setText[id](() => next.value);
      setCursor(next.cursor);
    }
  });

  /** A label + scrollable value row (used by the backend and keep-source choosers). */
  const chooserRow = (
    f: FieldDef,
    focused: boolean,
    inner: string,
    canLeft: boolean,
    canRight: boolean,
  ): React.ReactElement => (
    <Box key={f.id}>
      <Box width={18}>
        <Text color={focused ? "cyan" : undefined}>
          {focused ? "› " : "  "}
          {f.label}
        </Text>
      </Box>
      <Text color={focused ? "cyan" : undefined}>
        {focused && canLeft ? "‹ " : "  "}
        {inner}
        {focused && canRight ? " ›" : ""}
      </Text>
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
    >
      <Text bold color="blue">
        Build a managed llama.cpp install
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, i) => {
          const focused = i === focus;

          if (f.id === "backend") {
            return chooserRow(
              f,
              focused,
              BACKENDS[backendIdx]!,
              backendIdx > 0,
              backendIdx < BACKENDS.length - 1,
            );
          }
          if (f.id === "allowUnsupported") {
            return chooserRow(f, focused, allowUnsupported ? "on" : "off", true, true);
          }

          const id = f.id as TextFieldId;
          const value = text[id];
          const placeholder =
            id === "repo"
              ? REPO_PLACEHOLDER
              : id === "ref"
                ? "default branch (or pr/123)"
                : id === "cudaHostCompiler"
                  ? "default (e.g. g++-15)"
                  : "auto";
          return (
            <Box key={f.id}>
              <Box width={18}>
                <Text color={focused ? "cyan" : undefined}>
                  {focused ? "› " : "  "}
                  {f.label}
                </Text>
              </Box>
              <CursorText
                value={value}
                cursor={cursor}
                focused={focused}
                placeholder={placeholder}
                width={valueWidth}
              />
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <ShortcutBar
          items={[
            { key: "Tab/↑↓", desc: "move" },
            { key: "←/→", desc: "adjust" },
            { key: "Enter", desc: "build" },
            { key: "Esc", desc: "cancel" },
          ]}
        />
      </Box>
    </Box>
  );
}
