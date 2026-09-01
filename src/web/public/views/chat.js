/**
 * Chat playground — the TUI's `c`. Streams from the running instance's
 * OpenAI-compatible endpoint through the web layer's passthrough route (a
 * browser can't reach the child's port directly). System prompts are out of
 * scope, as in the TUI: the launch flags govern behaviour.
 */

import { el } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { openModal } from "./modal.js";

export function openChat(row) {
  /** Transcript in the shape the completions API wants. */
  const messages = [];
  const log = el("div", { className: "chat-log" });
  const input = el("textarea", {
    placeholder: "Message…  (Enter to send, Shift+Enter for a newline)",
  });

  let controller = null;

  const sendBtn = el("button", { className: "primary", textContent: "Send", onclick: () => void send() });
  const stopBtn = el("button", { textContent: "Stop", disabled: true, onclick: () => controller?.abort() });

  function addMessage(role, text) {
    const node = el(
      "div",
      { className: `chat-msg ${role}` },
      el("div", { className: "who", textContent: role === "user" ? "you" : row.name }),
      el("span", { textContent: text }),
    );
    log.append(node);
    log.scrollTop = log.scrollHeight;
    return node.lastChild;
  }

  async function send() {
    const text = input.value.trim();
    if (text === "" || controller) return;
    input.value = "";
    messages.push({ role: "user", content: text });
    addMessage("user", text);
    const target = addMessage("assistant", "…");

    controller = new AbortController();
    sendBtn.disabled = true;
    stopBtn.disabled = false;
    let reply = "";
    try {
      await api.chat(row.modelId, messages, {
        signal: controller.signal,
        onDelta: (delta) => {
          reply += delta;
          target.textContent = reply;
          log.scrollTop = log.scrollHeight;
        },
      });
      if (reply === "") target.textContent = "(empty reply)";
      messages.push({ role: "assistant", content: reply });
    } catch (e) {
      if (e.name === "AbortError") {
        // Keep the partial reply in the transcript so context stays coherent.
        target.textContent = reply === "" ? "(stopped)" : `${reply} (stopped)`;
        if (reply !== "") messages.push({ role: "assistant", content: reply });
      } else {
        target.textContent = `error: ${e.message}`;
        target.parentElement.classList.add("warn");
        messages.pop(); // drop the user turn that got no reply
      }
    } finally {
      controller = null;
      sendBtn.disabled = false;
      stopBtn.disabled = true;
      input.focus();
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
    // Esc would otherwise bubble to the modal and close the whole dialog
    // mid-composition; only let it through when the box is empty.
    if (e.key === "Escape" && input.value !== "") e.stopPropagation();
  });

  const handle = openModal({
    title: `Chat · ${row.name}`,
    subtitle: `http://${row.running.spec.host ?? "127.0.0.1"}:${row.running.port}`,
    body: el("div", {}, log, el("div", { className: "chat-input" }, input, sendBtn, stopBtn)),
    onClose: () => controller?.abort(),
  });
  input.focus();
  return handle;
}
