# AGENTS.md

Windows-only, offline Markdown reader: Python (pywebview) native window hosting a local HTML/CSS/JS UI in WebView2. No package manager/workspace, no linter, no CI, no git repo here.

## Commands

- Run from source: `python app/main.py` (optionally pass a file/folder path as an argument)
- No-GUI unit tests: `python tests/test_main.py` (encodings, config, startup args, bridge contracts; exits non-zero on failure)
- Renderer tests (Node, no GUI): `node tests/md_render_test.js` (101 assertions over markdown.js; loads it with a `window` shim — raw-HTML/sanitizer paths are covered in the WebView2 selftest instead), `node tests/md_math_test.js` (29 math assertions; miniTeX fallback because Node has no katex global) and `node tests/md_mermaid_test.js` (34 mermaid assertions incl. the V-model sample).
- Self-test (renders a fixed doc + XSS vectors + real UI-flow checks in WebView2, writes `selftest-result.json` next to the config, then exits): `python app/main.py --selftest`
- Build portable EXE: `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1` -> `dist\MDReader.exe` (plain `.\build.ps1` is blocked by the machine's execution policy). Runs pip install, `make_icon.py`, then PyInstaller.
- Manual build: `python -m PyInstaller mdreader.spec --noconfirm`

Release gate = all four green: `ALL TESTS PASSED` (Python) + `ALL RENDER TESTS PASSED` (Node) + `ALL MATH TESTS PASSED` (Node) + selftest JSON `total: true` with `phase: "final"` (74 checks). The selftest runs in two phases — an early DOMContentLoaded pass (renderer only, no listeners yet) and a final pass 300ms after `pywebviewready` (full UI suite incl. tab flows, mermaid zoom controls + manual % input, wide-diagram overflow, editor gutter, Ctrl+wheel zoom, find & replace, print CSS/bridge checks). `main.py` polls only for `phase === "final"`.
`build.ps1` kills running MDReader instances and deletes the old EXE first (a locked EXE used to silently produce a stale build — verify the printed timestamp on every build).

## Architecture

- `app/main.py` is the sole Python entrypoint: window creation, config, and the `Api` class exposed to JS as `window.pywebview.api`.
- All Markdown parsing is client-side in `app/web/js/markdown.js` (self-written, zero deps, IIFE that sets global `MDRender`; includes a built-in miniTeX math renderer and mermaid block interception + `enhanceMermaid` post-processor). `app/web/js/mermaid-mini.js` is a self-written flowchart-subset SVG engine (`window.MermaidMini`: flowchart TD/LR/BT/RL, subgraph, 4 node shapes, solid/dot/thick edges with labels, cycle-safe layering). `app/web/js/app.js` is the controller (IIFE that sets global `__MDR__`/`__mdr` debug + drop hooks; implements Chrome-like tabs in `state.tabs` with per-tab scroll memory and config-key `tabs` session restore).
- Optional vendored libraries auto-upgrade rendering with zero code changes: `web/vendor/katex/` (katex.min.js + katex.min.css + fonts/) for math, `web/vendor/mermaid/mermaid.min.js` for full mermaid DSL. The script tags are always present in index.html; missing files 404 harmlessly and `renderMath`/`enhanceMermaid` fall back to the built-in engines (miniTeX / MermaidMini), then to raw source display. Theme switches re-render mermaid blocks (`MDRender.rerenderMermaid`).
- Math rendering is dual-mode: `renderMath()` uses `window.katex.renderToString` when `app/web/vendor/katex/katex.min.js` is loaded by index.html (the script/link lines are commented out by default — uncomment + rebuild to enable), otherwise falls back to the internal `miniTeX` subset (greek, scripts, \frac, \sqrt, accents, operators). Inline `$...$` detection deliberately rejects pure-number content and requires a start/space/bracket/CJK char before `$` so money strings like "$5 and $10" stay literal; `$` inside code spans never triggers math (inline-code stash runs before math detection).
- File I/O, folder listing, relative-image loading (`read_asset` -> base64 `data:` URL), external links, and drag-drop all go through the Python `Api` bridge. JS must not assume browser file APIs work (no `FileReader`/`createObjectURL`; WebView2 `File` objects have no `.path`).
- Front-end is bundled by PyInstaller via `mdreader.spec` (`datas` maps `app/web` -> `web`, plus `assets/icon.png` and `samples/welcome.md`). New runtime assets must be added there or they will be missing in the EXE.
- Generated (not source): `mdreader.config.json` (repo root in dev / next to EXE when frozen), `.webview-cache/`, `selftest-result.json`, `build/`, `dist/`.
- Edge-case test corpus: `samples/edge/` (GB18030, UTF-16, BOM, 1.4MB, malformed, XSS vectors, relative images). Regenerate encodings with `python samples/edge/_make_samples.py`.

## pywebview 6.x contracts (hard-won)

- NEVER store a non-private object reference as a public attribute of `Api`. pywebview's `inject_pywebview` walks every public attribute recursively to expose it to JS; a `Window` reference makes it walk the whole native WinForms tree (`window.native.AccessibilityObject.Bounds.Empty.Empty...`) -> recursion blowup that freezes the window on the GUI thread. Keep back-references private (`self._window`).
- File dialog filter names must match `webview.util.parse_file_type` regex `^([\w ]+)\(...\)$` — only word chars and spaces, NO `/` or other symbols. `"Markdown / Text (*.md;...)"` raises at click time (toast "not a valid file filter"). The real strings live in `main.FILE_DIALOG_TYPES` and are regression-tested in `tests/test_main.py`.
- Drag & drop REQUIRES the Python-side subscription `window.dom.document.events.drop += api.handle_drop` in `_after_load` (pywebview only captures `CoreWebView2File` paths when `_dnd_state['num_listeners'] > 0`; otherwise paths are silently discarded in `platforms/edgechromium.py`).
- Real dropped paths arrive under the key `pywebviewFullPath` (NOT `path`) in the file dicts passed to `handle_drop`; `Api._normalize_path` handles both.
- requirements.txt pins `pywebview>=6.1,<7` — the walker/drop behavior above is version-specific; don't let the major version drift.

## Gotchas

- WebView2 / `file://` URLs cannot take a query string — `main.py` uses a `#selftest=1` hash; `app.js` `isSelfTest()` tests `location.hash + location.search`. Don't add `?foo=` to the page URL.
- JS starts only after the `pywebviewready` event; a 1.2s fallback calls `boot()` for plain-browser mode (no Python bridge, so no file access).
- Startup file is delivered by the UI polling `take_startup_file()` once; drag-drop paths by the Python `handle_drop` push + `take_dropped()` 800ms poll backstop. Keep this consume-once contract when touching opening logic.
- Self-test contract: on `#selftest=1`, `app.js` sets `window.__SELFTEST__`; `main.py` polls `window.evaluate_js` for it and writes the JSON. Changing the global name or result shape breaks `--selftest`.
- `index.html` loads `js/markdown.js` before `js/app.js`; `MDRender` must exist globally.
- Renderer output is HTML-sanitized in `markdown.js` `sanitizeHtml` (tag whitelist `ALLOWED_TAGS`, unwraps unknown tags, strips `on*`, `javascript:`/`vbscript:`/`data:text/html` URLs, comments). Preserve sanitization; selftest asserts XSS vectors stay inert. Inline HTML inside paragraphs is intentionally displayed as literal text (safety-first; documented in samples/edge/xss测试.md).
- `make_icon.py` requires Pillow (in requirements.txt since the build needs it) but `PIL` is excluded from the EXE bundle via `mdreader.spec` excludes — keep that exclusion.
- Text decoding fallback order in `read_text_file` (`utf-8-sig`, `utf-8`, `gb18030`, `utf-16`, `latin-1`) handles mixed-encoding docs; don't simplify to plain UTF-8.
- WebView2 blocks script-initiated `window.close()` on the main window — the 退出 menu item MUST quit via `Api.quit_app()` (`window.destroy()`), never via `window.close()`. Quitting with dirty tabs shows an in-page confirm modal (`#quitModal`) first.
- Editing this repo's files that contain Chinese comments from PowerShell one-liners can corrupt UTF-8 (GBK console round-trip). Use the file editing tools, or keep throwaway script comments ASCII.
- The repo's JS/CSS files use LF line endings. PowerShell `.Replace()` patterns containing `` `r`n `` silently no-op against them — a "successful" command may change nothing. Verify edits with `Select-String` or use the file editing tools.
- The find bar input has a 200ms debounce; selftest find/replace cases call `doFind()` directly instead of dispatching `input` events so assertions stay synchronous.
- Content column width is CONFIG-DRIVEN: `applyZoom()` sets `--content-max` from `cfg.maxWidth` (default 1280, defined in BOTH `main.py` DEFAULT_CONFIG and the app.js fallback), overriding the stylesheet. Old configs holding the legacy default 860 are migrated in `load_config()`. Don't "fix" narrow content by editing CSS alone.
- The editor gutter (`#editorGutter`) requires the textarea to keep `wrap="off"` — soft wrap would break line-number alignment. Gutter and textarea must keep identical font-size/line-height/padding-top (enforced by a selftest check).
- WebView2 caches file:// subresources in `.webview-cache` (repo root in dev, next to EXE when frozen). If CSS/JS edits don't show up in a normal dev run, delete that folder; `--selftest` wipes it automatically, and normal runs wipe it when `APP_VERSION` changes (config key `assetVersion`).
- Printing: `window.print()` opens the Edge print dialog whose header/footer (date/title/URL/page numbers) defaults ON and CANNOT be disabled programmatically. Ctrl+P therefore routes to `Api.print_to_pdf` → native `CoreWebView2.PrintToPdfAsync` (A4, `ShouldPrintHeaderAndFooter=False`, backgrounds on, margins 0 — CSS `@page { size: A4; margin: 16mm 14mm }` controls layout). CoreWebView2 must only be touched on the GUI thread (`control.BeginInvoke(Action(...))`); NEVER block the GUI thread on the async print task (deadlock) — poll `task.Status` from the js_api thread. The `@media print` CSS hides all app chrome (`.tabbar`, `.editor-wrap`, `.findbar`, `.mermaid-zoomctrl`, …) and applies to any print path.

## Conventions

- Code comments/docstrings and UI strings/docs are Chinese; keep that style.
- No dependency additions: this project deliberately ships zero-JS-dependency, offline-only (no CDN, no network).
