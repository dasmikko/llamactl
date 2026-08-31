/**
 * Chat playground for a running instance: a transcript (latest lines pinned
 * to the bottom) plus a single-line input. Streams /v1/chat/completions (SSE) from the instance's
 * own endpoint directly — the host comes from the launch spec (loopback by
 * default), the port from daemon state. Esc stops an in-flight reply (the
 * partial text is kept); a second Esc, or Esc when idle, closes the panel.
 */

import { createSignal, onCleanup, Show, For } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { streamChat, fetchModelName, type ChatMessage } from "./chat.ts";
import { ShortcutBar } from "./ShortcutBar.tsx";
import { CursorText, editText, type TextEdit } from "./textinput.tsx";
import { C } from "./theme.ts";
import type { RunningModel } from "../types.ts";

export interface ChatViewProps {
  /** The running instance to chat with (the app re-resolves it by modelId). */
  running: RunningModel;
  /** Close the panel (return to the table). */
  onClose: () => void;
}

export function ChatView(props: ChatViewProps) {
  const dims = useTerminalDimensions();
  const columns = (): number => dims().width || 80;

  // The instance's HTTP endpoint. The app re-resolves `props.running` from
  // daemon state, so host/port stay current if the spec ever changes.
  const endpoint = (): string => {
    const rm = props.running;
    return `http://${rm.spec.host ?? "127.0.0.1"}:${rm.port}`;
  };

  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [input, setInput] = createSignal<TextEdit>({ value: "", cursor: 0 });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The in-flight request (if any) and the cached served model name.
  let abort: AbortController | null = null;
  let modelName: string | null = null;

  // Drop a trailing empty assistant slot (no deltas arrived) so the
  // transcript doesn't show a bare "model" label.
  const dropTrailingEmptyAssistant = (): void => {
    setMessages((m) => {
      const last = m[m.length - 1];
      return last && last.role === "assistant" && last.text === "" ? m.slice(0, -1) : m;
    });
  };

  const send = async (): Promise<void> => {
    const text = input().value.trim();
    if (!text || busy()) return;
    const rm = props.running;
    const base = endpoint();
    const history: ChatMessage[] = [...messages(), { role: "user", text }];
    setInput({ value: "", cursor: 0 });
    setError(null);
    setBusy(true);
    // User turn + an empty assistant slot that fills as deltas stream in.
    setMessages([...history, { role: "assistant", text: "" }]);
    const controller = new AbortController();
    abort = controller;
    try {
      if (!modelName) modelName = await fetchModelName(base, rm.name);
      await streamChat({
        baseUrl: base,
        model: modelName,
        messages: history,
        signal: controller.signal,
        onDelta: (d) =>
          setMessages((m) => {
            const last = m[m.length - 1];
            if (!last || last.role !== "assistant") return m;
            const copy = m.slice();
            copy[copy.length - 1] = { role: "assistant", text: last.text + d };
            return copy;
          }),
      });
      // A completed reply with no content at all: drop the empty slot.
      dropTrailingEmptyAssistant();
    } catch (e) {
      if (!controller.signal.aborted) {
        dropTrailingEmptyAssistant();
        setError(e instanceof Error ? e.message : String(e));
      }
      // Aborted: the partial reply (if any) stays in the transcript.
    } finally {
      abort = null;
      setBusy(false);
    }
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (busy()) {
        abort?.abort(); // finalize the partial; a second Esc closes
        return;
      }
      props.onClose();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      void send();
      return;
    }
    const next = editText(input(), key);
    if (next) setInput(next);
  });

  // Closing the panel (or the app quitting) aborts an in-flight stream.
  onCleanup(() => abort?.abort());

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
      flexGrow={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={C.accent} attributes={TextAttributes.BOLD}>
          {`CHAT · ${props.running.name}`}
        </text>
        <text fg={C.text} attributes={TextAttributes.DIM}>
          {endpoint()}
        </text>
      </box>

      {/*
        Transcript: a plain column pinned to the bottom (flex-end). When the
        conversation outgrows the panel the oldest lines clip off the top and
        the latest stay visible — chat behavior without a scrollbox (opentui's
        sticky scroll mis-measures short content and hides it).
      */}
      <box flexDirection="column" flexGrow={1} justifyContent="flex-end" marginTop={1}>
        <Show when={messages().length === 0 && !error()}>
          <text fg={C.text} attributes={TextAttributes.DIM}>
            {"Ask the model anything. The conversation stays in this panel."}
          </text>
        </Show>
        <For each={messages()}>
          {(m) => (
            <box flexDirection="column" marginTop={m.role === "user" ? 1 : 0}>
              <text
                fg={m.role === "user" ? C.accent : C.info}
                attributes={TextAttributes.BOLD}
              >
                {m.role === "user" ? "you" : "model"}
              </text>
              <text fg={C.text}>{m.text || (busy() ? "…" : "")}</text>
            </box>
          )}
        </For>
      </box>

      <Show when={error()}>
        <text fg={C.danger} marginTop={1}>
          {error()}
        </text>
      </Show>

      <box flexDirection="row" marginTop={1}>
        <text fg={C.accent}>{"> "}</text>
        <CursorText
          value={input().value}
          cursor={input().cursor}
          focused
          width={Math.max(8, columns() - 36)}
        />
        <text>{"  "}</text>
        <ShortcutBar
          items={
            busy()
              ? [{ key: "Esc", desc: "stop" }]
              : [
                  { key: "Enter", desc: "send" },
                  { key: "Esc", desc: "close" },
                ]
          }
        />
      </box>
    </box>
  );
}
