/**
 * Control-plane client. Every call goes to this server's same-origin `/api/*`
 * proxy, which injects the daemon's bearer token — the browser never holds it.
 * The method set mirrors src/tui/useDaemon.ts so the two front ends drive the
 * daemon identically.
 */

/** One request; throws an Error carrying the daemon's typed code on failure. */
async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`malformed response from ${path}: ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const err = new Error(
      data?.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${res.status}`,
    );
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  // ---- state -------------------------------------------------------------
  models: () => request("GET", "/models"),
  ps: () => request("GET", "/ps"),
  stats: () => request("GET", "/stats"),
  instances: () => request("GET", "/instances"),
  favorites: () => request("GET", "/favorites"),
  downloads: () => request("GET", "/downloads"),
  installs: () => request("GET", "/installs"),
  /** Flags the active llama-server binary accepts, parsed from its --help. */
  llamaFlags: () => request("GET", "/llama/flags"),

  // ---- instances ---------------------------------------------------------
  start: (req) => request("POST", "/start", req),
  stop: (model) => request("POST", "/stop", { model }),

  // ---- saved profiles ----------------------------------------------------
  createInstance: (id, name, spec) => request("POST", "/instances", { id, name, spec }),
  updateInstance: (id, patch) => request("PUT", `/instances/${enc(id)}`, patch),
  removeInstance: (id) => request("DELETE", `/instances/${enc(id)}`),

  // ---- catalog -----------------------------------------------------------
  toggleFavorite: (id) => request("POST", `/favorites/${enc(id)}/toggle`),
  deleteModel: (id) => request("DELETE", `/models/${enc(id)}`),

  // ---- Hugging Face ------------------------------------------------------
  searchHf: (q) => request("GET", `/hf/search?q=${enc(q)}`),
  listHfFiles: (repo) => request("GET", `/hf/files?repo=${enc(repo)}`),
  pull: (repo, file) => request("POST", "/pull", { repo, file }),
  cancelDownload: (id) => request("POST", `/downloads/${enc(id)}/cancel`),
  retryDownload: (id) => request("POST", `/downloads/${enc(id)}/retry`),
  dismissDownload: (id) => request("DELETE", `/downloads/${enc(id)}`),

  // ---- managed llama.cpp installs ---------------------------------------
  startBuild: (req) => request("POST", "/installs", req),
  cancelBuild: (id) => request("POST", `/installs/${enc(id)}/cancel`),
  setActiveInstall: (id) => request("PUT", "/installs/active", { id }),
  removeInstall: (id) => request("DELETE", `/installs/${enc(id)}`),
  renameInstall: (id, name) => request("PATCH", `/installs/${enc(id)}`, { name }),
  updateInstall: (id) => request("POST", `/installs/${enc(id)}/update`, {}),

  // ---- served by the web layer, not the control plane --------------------
  modelLog: (modelId) => request("GET", `/logs/model/${enc(modelId)}`),
  buildLog: (buildId) => request("GET", `/logs/build/${enc(buildId)}`),
  restartDaemon: () => request("POST", "/daemon/restart", {}),

  /**
   * Stream a chat completion from a running instance. Calls `onDelta(text)` for
   * each token as it arrives and resolves when the stream ends. `signal` aborts
   * it. The response is relayed by the web layer from the child's
   * OpenAI-compatible endpoint, so this is the same SSE the TUI parses.
   */
  async chat(modelId, messages, { onDelta, signal }) {
    const res = await fetch(`/api/chat/${enc(modelId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, stream: true }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        /* not our envelope; fall through to the raw text */
      }
      throw new Error(data?.error ? `${data.error.code}: ${data.error.message}` : text);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Split complete SSE lines; a partial line stays in the buffer.
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (payload === "" || payload === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // a malformed event shouldn't kill the stream
        }
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      }
    }
  },
};
