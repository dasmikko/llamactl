/**
 * Modal form to start a managed llama.cpp build. Hand-rolled controlled inputs
 * via useInput (no extra deps), mirroring FlagEditor/HfBrowser idioms: Tab/↑/↓
 * move between fields, typing edits text fields, ←/→ adjust the backend chooser
 * and toggle keep-source, Enter submits, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BuildRequest, LlamaBackend } from "../types.ts";
import { useTheme } from "./theme.ts";

export interface BuildFormProps {
  onSubmit: (req: BuildRequest) => void;
  onCancel: () => void;
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

/** Default git repo offered as the placeholder hint for the Repo URL field. */
const REPO_PLACEHOLDER = "https://github.com/ggml-org/llama.cpp";

export function BuildForm({ onSubmit, onCancel }: BuildFormProps): React.ReactElement {
  const theme = useTheme();
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [cudaHostCompiler, setCudaHostCompiler] = useState("");
  // Default backend is cuda (index 1).
  const [backendIdx, setBackendIdx] = useState(1);
  const [allowUnsupported, setAllowUnsupported] = useState(false);
  const [focus, setFocus] = useState(0);

  const text: Record<TextFieldId, string> = { repo, ref, name, cudaHostCompiler };
  const setText: Record<TextFieldId, (fn: (s: string) => string) => void> = {
    repo: setRepo,
    ref: setRef,
    name: setName,
    cudaHostCompiler: setCudaHostCompiler,
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
      setFocus((f) => (f + 1) % FIELDS.length);
      return;
    }
    if (key.upArrow) {
      setFocus((f) => (f - 1 + FIELDS.length) % FIELDS.length);
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
    if (key.backspace || key.delete) {
      setText[id]((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText[id]((s) => s + input);
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
        <Text color={focused ? theme.accent : theme.text}>
          {focused ? "› " : "  "}
          {f.label}
        </Text>
      </Box>
      <Text color={focused ? theme.accent : theme.text}>
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
      borderColor={theme.info}
      paddingX={1}
    >
      <Text bold color={theme.info}>
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
                <Text color={focused ? theme.accent : theme.text}>
                  {focused ? "› " : "  "}
                  {f.label}
                </Text>
              </Box>
              {value === "" && !focused ? (
                <Text dimColor>{placeholder}</Text>
              ) : (
                <Text inverse={focused} wrap="truncate-start">
                  {value}
                  {focused ? "▏" : ""}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Tab/↑↓ move · ←/→ adjust · Enter build · Esc cancel</Text>
      </Box>
    </Box>
  );
}
