/**
 * Minimal OpenAI-compatible chat client for the TUI playground. The TUI
 * talks directly to a running instance's loopback HTTP endpoint (it already
 * knows the host/port from daemon state) — no daemon proxying. Replies are
 * streamed via SSE on /v1/chat/completions and parsed incrementally so
 * partial text renders as it arrives.
 */

/**
 * One transcript line. Roles are just user/assistant: system prompts are out
 * of scope for the playground — the server's launch flags govern behaviour.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Incremental SSE parser for chat-completion streams. Feed raw body chunks of
 * any size; it returns the JSON payload of each completed `data:` event,
 * handling events split across chunk boundaries, CRLF, comments, and
 * `event:`/`id:`/`retry:` lines. `data: [DONE]` (the stream terminator) is
 * consumed, not returned.
 */
export class SseParser {
  private buf = "";

  /** Push a chunk of the stream; returns the completed data payloads. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trimStart();
      if (data === "" || data === "[DONE]") continue;
      out.push(data);
    }
    return out;
  }
}

/** The slice of a chat-completion SSE event this client cares about. */
interface ChatDeltaEvent {
  choices?: { delta?: { content?: string | null } }[];
}

export interface StreamChatOptions {
  /** Instance base URL, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** Model name to send (from /v1/models, or a fallback). */
  model: string;
  /** Conversation so far, oldest first (the new user turn included). */
  messages: ChatMessage[];
  /** Abort signal (Esc in the TUI). */
  signal: AbortSignal;
  /** Called for each assistant content delta as it arrives. */
  onDelta: (text: string) => void;
}

/**
 * POST /v1/chat/completions with stream:true and feed content deltas to
 * `onDelta` until the stream ends. Rejects on HTTP errors (carrying the
 * server's message when it has one) or if the signal aborts.
 */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The wire format is OpenAI's: { role, content } (not our internal `text`).
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.text })),
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = res.body.getReader();
  const feed = (chunk: string): void => {
    for (const data of parser.push(chunk)) {
      let evt: ChatDeltaEvent;
      try {
        evt = JSON.parse(data) as ChatDeltaEvent;
      } catch {
        continue; // malformed frame; skip
      }
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) opts.onDelta(delta);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  feed(decoder.decode()); // flush a trailing multi-byte character, if any
}

/**
 * The model id the instance reports at /v1/models (the value
 * /v1/chat/completions expects). Falls back to `fallback` if the lookup
 * fails — servers generally tolerate any name, but the real one is safest.
 */
export async function fetchModelName(baseUrl: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    if (!res.ok) return fallback;
    const j = (await res.json()) as { data?: { id?: string }[] };
    return j.data?.[0]?.id ?? fallback;
  } catch {
    return fallback;
  }
}
