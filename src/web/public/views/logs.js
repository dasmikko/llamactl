/**
 * Log viewer — the TUI's `l`. Tails a running child's log, or a build's, by
 * polling the web layer's log route (the daemon has none; the file is read
 * locally). Sticks to the bottom unless the user has scrolled up.
 */

import { el } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { openModal } from "./modal.js";

const REFRESH_MS = 1000;

function openLog({ title, fetchTail }) {
  const pre = el("pre", { className: "log", textContent: "loading…" });

  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetchTail();
      if (stopped) return;
      // Preserve the reading position: only auto-scroll when already at the
      // bottom, so scrolling back through a build log isn't yanked away.
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = res.missing ? "(log file not created yet)" : res.lines.join("\n");
      handle.setSubtitle(
        res.missing ? res.logPath : `${res.lines.length} of ${res.total} lines · ${res.logPath}`,
      );
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      if (!stopped) pre.textContent = `could not read log: ${e.message}`;
    }
  }

  const interval = setInterval(() => void tick(), REFRESH_MS);
  const handle = openModal({
    title,
    body: pre,
    onClose: () => {
      stopped = true;
      clearInterval(interval);
    },
  });
  void tick();
  return handle;
}

/** Tail a running instance's log. */
export function openModelLog(row) {
  return openLog({
    title: `Log · ${row.name}`,
    fetchTail: () => api.modelLog(row.modelId),
  });
}

/** Tail a managed build's log. */
export function openBuildLog(build) {
  return openLog({
    title: `Build log · ${build.name ?? build.id}`,
    fetchTail: () => api.buildLog(build.id),
  });
}
