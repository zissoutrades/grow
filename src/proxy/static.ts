/**
 * Static UI assets, embedded into the compiled executable (PROTOCOL §1).
 *
 * The `with { type: "text" }` imports make Bun treat each file as a module:
 * `bun build --compile` stores the contents inside the executable, and the exe
 * serves the demo UI with no files beside it. In dev the same imports return
 * the file contents, so `bun run` and the exe share one code path.
 *
 * Adding a file under `src/ui/` means adding one import and one map entry; the
 * map is also the traversal guard (unknown paths are a 404, never a disk read).
 */

import indexHtml from "../ui/index.html" with { type: "text" };
import appJs from "../ui/app.js" with { type: "text" };
import canvasJs from "../ui/canvas.js" with { type: "text" };
import consoleHtml from "../ui/console.html" with { type: "text" };
import consoleJs from "../ui/console.js" with { type: "text" };
import coreJs from "../ui/core.js" with { type: "text" };
import localeJs from "../ui/locale.js" with { type: "text" };
import proxyClientJs from "../ui/proxy-client.js" with { type: "text" };
import styleCss from "../ui/style.css" with { type: "text" };
import workletsJs from "../ui/worklets.js" with { type: "text" };

export interface UiAsset {
  /** File contents embedded at build time. */
  readonly body: string;
  readonly contentType: string;
}

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

const ASSETS: Readonly<Record<string, UiAsset>> = {
  "index.html": { body: indexHtml, contentType: HTML },
  "console.html": { body: consoleHtml, contentType: HTML },
  "app.js": { body: appJs, contentType: JS },
  "canvas.js": { body: canvasJs, contentType: JS },
  "console.js": { body: consoleJs, contentType: JS },
  "core.js": { body: coreJs, contentType: JS },
  "locale.js": { body: localeJs, contentType: JS },
  "proxy-client.js": { body: proxyClientJs, contentType: JS },
  "worklets.js": { body: workletsJs, contentType: JS },
  "style.css": { body: styleCss, contentType: CSS },
};

/** Resolve a UI-relative path (no leading slash required); null when absent. */
export function uiAsset(relativePath: string): UiAsset | null {
  const key = relativePath.replace(/^\/+/, "");
  return ASSETS[key] ?? null;
}
