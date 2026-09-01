/**
 * Static assets for the web UI.
 *
 * Every file is imported as text so it is inlined at bundle time and travels
 * inside the compiled binary — no asset directory to ship or resolve at
 * runtime, the same trick as the `type: "file"` import of libopentui.so. The
 * manifest is explicit rather than a directory scan for exactly that reason: a
 * scan would find nothing in a compiled binary.
 *
 * The page loads these as native ES modules (`<script type="module">`), so
 * there is no bundler and no build step for the front end. Shared logic the
 * TUI also uses is served separately from `modules.ts`.
 */

import indexHtml from "./public/index.html" with { type: "text" };
import styleCss from "./public/style.css" with { type: "text" };
import appJs from "./public/app.js" with { type: "text" };
import apiJs from "./public/lib/api.js" with { type: "text" };
import domJs from "./public/lib/dom.js" with { type: "text" };
import storeJs from "./public/lib/store.js" with { type: "text" };
import modalJs from "./public/views/modal.js" with { type: "text" };
import catalogJs from "./public/views/catalog.js" with { type: "text" };
import infoJs from "./public/views/info.js" with { type: "text" };
import profilesJs from "./public/views/profiles.js" with { type: "text" };
import flagsJs from "./public/views/flags.js" with { type: "text" };
import hfJs from "./public/views/hf.js" with { type: "text" };
import downloadsJs from "./public/views/downloads.js" with { type: "text" };
import installsJs from "./public/views/installs.js" with { type: "text" };
import chatJs from "./public/views/chat.js" with { type: "text" };
import logsJs from "./public/views/logs.js" with { type: "text" };

export interface Asset {
  body: string;
  contentType: string;
}

function typeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/javascript; charset=utf-8";
}

const FILES: Record<string, string> = {
  "/index.html": indexHtml,
  "/style.css": styleCss,
  "/app.js": appJs,
  "/lib/api.js": apiJs,
  "/lib/dom.js": domJs,
  "/lib/store.js": storeJs,
  "/views/modal.js": modalJs,
  "/views/catalog.js": catalogJs,
  "/views/info.js": infoJs,
  "/views/profiles.js": profilesJs,
  "/views/flags.js": flagsJs,
  "/views/hf.js": hfJs,
  "/views/downloads.js": downloadsJs,
  "/views/installs.js": installsJs,
  "/views/chat.js": chatJs,
  "/views/logs.js": logsJs,
};

/** URL path → asset. `/` is served as `/index.html`. */
export const ASSETS: ReadonlyMap<string, Asset> = new Map(
  Object.entries(FILES).map(([path, body]) => [path, { body, contentType: typeFor(path) }]),
);
