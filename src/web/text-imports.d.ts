/**
 * Everything under `public/` is imported with `with { type: "text" }` — Bun
 * hands back the file's source as a string so it can be inlined into the
 * compiled binary. TypeScript has no model for that import attribute: left
 * alone it resolves `./public/app.js` as an untyped JS module, `./public/*.css`
 * as nothing at all, and `./public/index.html` as bun-types' HTMLBundle.
 *
 * Ambient patterns are matched against the specifier text and only support one
 * `*`, and a pattern starting with `./` is treated as a relative path rather
 * than a pattern — hence one leading-star entry per file rather than a single
 * `public/**` rule. A blanket `*.js` would work too, but would silently type
 * any future ordinary `.js` import in the project as a string.
 *
 * Keep this list in step with the manifest in assets.ts. It must NOT be named
 * `assets.d.ts`: a `.d.ts` beside a `.ts` of the same name is taken as that
 * file's declaration file and silently drops out of the program, so every
 * declaration here would be ignored.
 */

declare module "*/public/index.html" { const c: string; export default c; }
declare module "*/public/style.css" { const c: string; export default c; }
declare module "*/public/app.js" { const c: string; export default c; }
declare module "*/public/lib/api.js" { const c: string; export default c; }
declare module "*/public/lib/dom.js" { const c: string; export default c; }
declare module "*/public/lib/store.js" { const c: string; export default c; }
declare module "*/public/views/modal.js" { const c: string; export default c; }
declare module "*/public/views/catalog.js" { const c: string; export default c; }
declare module "*/public/views/info.js" { const c: string; export default c; }
declare module "*/public/views/profiles.js" { const c: string; export default c; }
declare module "*/public/views/flags.js" { const c: string; export default c; }
declare module "*/public/views/hf.js" { const c: string; export default c; }
declare module "*/public/views/downloads.js" { const c: string; export default c; }
declare module "*/public/views/installs.js" { const c: string; export default c; }
declare module "*/public/views/chat.js" { const c: string; export default c; }
declare module "*/public/views/logs.js" { const c: string; export default c; }
