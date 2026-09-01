/**
 * Hugging Face browser — the TUI's `p`. Search repos, expand one to its GGUF
 * files, and pull. The daemon owns the download (and expands a sharded file to
 * its whole group), so pulling is fire-and-forget: progress shows up in the
 * downloads panel.
 */

import { el, bytes } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state, refreshDynamic } from "../lib/store.js";
import { openModal } from "./modal.js";
import { openDownloads } from "./downloads.js";

/** Files already on disk, so the browser can mark what's downloaded. */
function haveFile(repo, rfilename) {
  const base = rfilename.split("/").pop();
  return state.models.some((m) => m.repo === repo && m.path.endsWith(`/${base}`));
}

export function openHfBrowser() {
  const results = el("div", {});
  const input = el("input", {
    type: "search",
    placeholder: "Search Hugging Face for GGUF models…",
    onkeydown: (e) => {
      if (e.key === "Enter") void search();
    },
  });
  const searchBtn = el("button", { className: "primary", textContent: "Search", onclick: () => void search() });

  async function search() {
    const q = input.value.trim();
    if (q === "") return;
    results.replaceChildren(el("div", { className: "dim", textContent: "searching…" }));
    searchBtn.disabled = true;
    try {
      const { repos } = await api.searchHf(q);
      if (repos.length === 0) {
        results.replaceChildren(el("div", { className: "dim", textContent: "(no repos matched)" }));
        return;
      }
      results.replaceChildren(...repos.map(repoRow));
    } catch (e) {
      results.replaceChildren(el("div", { className: "warn", textContent: e.message }));
    } finally {
      searchBtn.disabled = false;
    }
  }

  function repoRow(repo) {
    const files = el("div", {});
    let loaded = false;

    const toggle = el("button", {
      textContent: "files",
      onclick: async () => {
        if (loaded) {
          files.hidden = !files.hidden;
          return;
        }
        toggle.disabled = true;
        files.replaceChildren(el("div", { className: "dim", textContent: "loading files…" }));
        try {
          const res = await api.listHfFiles(repo.id);
          loaded = true;
          files.replaceChildren(
            ...(res.files.length === 0
              ? [el("div", { className: "dim", textContent: "(no GGUF files in this repo)" })]
              : res.files.map((f) => fileRow(repo, f))),
          );
        } catch (e) {
          files.replaceChildren(el("div", { className: "warn", textContent: e.message }));
        } finally {
          toggle.disabled = false;
        }
      },
    });

    return el(
      "div",
      {},
      el(
        "div",
        { className: "row" },
        el(
          "span",
          { className: "name" },
          el("a", {
            href: `https://huggingface.co/${repo.id}`,
            target: "_blank",
            rel: "noreferrer",
            textContent: repo.id,
          }),
          repo.gated ? el("span", { className: "tag", textContent: "gated" }) : null,
        ),
        el("span", { className: "meta", textContent: `♥ ${repo.likes}` }),
        el("span", { className: "meta", textContent: `↓ ${repo.downloads}` }),
        el("span", {
          className: "meta",
          textContent: repo.updatedAt ? repo.updatedAt.slice(0, 10) : "",
        }),
        toggle,
      ),
      files,
    );
  }

  function fileRow(repo, file) {
    const have = haveFile(repo.id, file.rfilename);
    const pullBtn = el("button", {
      className: have ? "" : "primary",
      textContent: have ? "downloaded" : "pull",
      disabled: have,
      onclick: async () => {
        pullBtn.disabled = true;
        pullBtn.textContent = "queued";
        try {
          await api.pull(repo.id, file.rfilename);
          await refreshDynamic();
          openDownloads();
        } catch (e) {
          pullBtn.textContent = "failed";
          pullBtn.title = e.message;
        }
      },
    });
    return el(
      "div",
      { className: "row indent" },
      el("span", { className: "name", textContent: file.rfilename }),
      file.quant ? el("span", { className: "tag", textContent: file.quant }) : null,
      el("span", {
        className: "meta",
        textContent: file.sizeBytes === null ? "?" : bytes(file.sizeBytes),
      }),
      pullBtn,
    );
  }

  openModal({
    title: "Pull from Hugging Face",
    subtitle: "sharded files pull their whole group",
    body: el(
      "div",
      {},
      el("div", { className: "field" }, input, searchBtn),
      results,
    ),
  });
  input.focus();
}
