# Extension Stack Research — Chrome MV3 Side Panel (Leader/Follower Agent)

Researched 2026-09-03. All versions confirmed via `npm view <pkg> version time --json`, GitHub API (stars/issues/pushed_at), WXT/Chrome/Vitest docs, and by reading package source where noted.

## Answer-first summary

1. **WXT 0.21.4** (pushed 2026-08-11, repo active daily, 10.4k★, 201 open issues) is healthy, has a first-class `sidepanel` entrypoint, and is the base framework (satisfies N-03: it's a bundler/tooling layer, not an app framework).
2. WXT's `browser` global **stopped wrapping `webextension-polyfill` as of v0.20** — it's now just typed native `chrome`. For a Chrome-only extension, use `browser` from `#imports` (typed) or `chrome` directly; they're equivalent at runtime.
3. `userScripts` and `debugger` are plain manifest permissions to WXT — no special handling; `userScripts` also needs the user to flip a Chrome toggle (Developer Mode pre-138, "Allow User Scripts" per-extension 138+).
4. WXT dev-mode **always launches a fresh browser profile via `web-ext`**, not your real Chrome profile — persistence across runs requires `chromiumArgs: ['--user-data-dir=...']` + `keepProfileChanges: true`; it never attaches to your everyday Chrome.
5. **`@webext-core/messaging` v4.0.0** (2026-07-25, part of the 333★ webext-core monorepo, 5 open issues) is strictly **request/response**, one listener per type per JS context — confirmed by reading its 80-line source. It has **no stream helper**; long-lived SW→panel event streams need `chrome.runtime.connect` (`Port`) directly, or messaging-per-event with a sequence id.
6. **`webext-bridge`** (712★, last npm publish 6.0.1 in 2023 despite a repo push in May 2026) is stale on the registry — avoid. **`comlink`** (12.8k★, active) is for RPC/proxying objects, not built for reconnect-after-SW-restart semantics. Recommendation: **raw `chrome.runtime.Port` + a ~40-line typed wrapper**, because only a hand-rolled wrapper gives you the reconnect-on-SW-wake loop the run log needs.
7. **WXT's `storage` API** (`@wxt-dev/storage` 1.2.9, bundled into `wxt` as a direct dependency) wraps `chrome.storage.local/session/sync` with typed, versioned, migratable storage items — use it for settings/config. For the append-only run log and checkpoints, use **`idb` 8.0.3** (7.4k★, IndexedDB) since `chrome.storage.local` is quota-capped (10MB, 5MB pre-Chrome-113) and not built for streaming/large-log writes; `unlimitedStorage` permission removes the local quota but session storage stays 10MB/in-memory (1MB pre-Chrome-111).
8. For the tool-call transcript UI: **plain shadcn/ui (122.9k★) + Tailwind + Radix primitives**, porting the *pattern* of Vercel's **AI Elements** `Tool`/`Reasoning`/`Conversation` components (shadcn-registry components, not an npm package) without adopting the AI SDK's `UIMessage` types — they're plain React/Tailwind so this is a straight copy-and-adapt. `assistant-ui` (12k★, MIT) was already rejected by the user.
9. **Tailwind v4.3.3 + `@tailwindcss/vite`** is the current, Vite-native path (no PostCSS config needed) and works cleanly with WXT's Vite pipeline; **React 19.2.8** works with WXT via `@wxt-dev/module-react` (peer range `vite ^5.4.19 || ^6.3.4 || ^7 || ^8.0.0-0`, `wxt >=0.19.16` — no React-version pin, 18/19 both fine).
10. **Vitest 5.0.0 shipped literally today (2026-09-03)** — too fresh to pin on day one; **pin `vitest@4.1.11`** (2026-08-18, mature) and revisit 5.0 in a few weeks. Sibling attempts (`nanobrowser-next`, `nanobrowser-opencode`, both local, both WXT+`@webext-core/messaging`) don't mock `chrome` at all — they hide it behind a `BrowserPort` interface and use `FakeBrowserPort` in unit tests, only touching real Chrome in a separate CDP-spawned headless-Chromium e2e test. `vitest-chrome` is dead (single 0.1.0 release, 2023). Recommended: port/seam pattern for unit tests + WXT's bundled `wxt/testing` `fakeBrowser` (re-exports `@webext-core/fake-browser` 2.0.1) for anything that must touch `chrome.*` directly.

---

## 1. WXT

- **Version**: `wxt@0.21.4` (npm `dist-tags.latest`), published 2026-08-11. Next 0.21.x still active; `next` tag tracks a 0.20 beta oddly (pre-release channel naming quirk, ignore).
- **Release cadence**: frequent — 0.20.13→0.20.27 (13 patches) between Mar and Jun 2026, then 0.21.1–0.21.4 Jul–Aug 2026. Repo last pushed **2026-09-02** (https://github.com/wxt-dev/wxt).
- **Health**: 10,449★, 560 forks, 201 open issues, MIT, actively maintained by aklinker1 and contributors.
- **Side panel entrypoint (R-05)**: file-based — `entrypoints/sidepanel.html` or `entrypoints/sidepanel/index.html` (or `{name}.sidepanel.html`/`{name}.sidepanel/index.html` for multiple panels). WXT auto-generates the manifest key: Chrome gets `side_panel.default_path`, Firefox gets `sidebar_action` — a single entrypoint targets both. Meta-tag config: `manifest.default_icon`, `manifest.open_at_install`, `manifest.browser_style`, `manifest.include/exclude`. WXT auto-adds the `sidePanel` permission whenever a sidepanel entrypoint exists. Docs did not show a first-class helper for `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})` — call it yourself in `background.ts`, it's a plain `chrome.sidePanel` API call (Chrome 114+, requires the `sidePanel` permission — https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
- **`userScripts`/`debugger` permissions**: no special WXT config — plain entries in `manifest.permissions`. WXT auto-adds `tabs`/`scripting` in dev mode for HMR, on top of whatever you declare. Chrome's `userScripts` API additionally needs a **user-flipped toggle**, not just a manifest permission: pre-Chrome-138 the user must enable "Developer mode" at `chrome://extensions`; Chrome 138+ instead shows a per-extension "Allow User Scripts" toggle; if disabled, `chrome.userScripts` is `undefined` at runtime (https://developer.chrome.com/docs/extensions/reference/api/userScripts). `debugger` has no such toggle but triggers a visible "is debugging this browser" banner and CWS review scrutiny — plan a permission-justification note for store submission.
- **Dev-mode HMR / real Chrome profile**: WXT's `dev` command drives **`web-ext run`**, which **always creates a fresh profile** to avoid touching your existing browser data. It does **not** attach to your everyday Chrome. Persistence across dev sessions (only on Chromium) needs `webExt.chromiumArgs: ['--user-data-dir=./.wxt/chrome-data']` plus `webExt.keepProfileChanges: true`; `chromiumProfile` (Windows) and `binaries` (custom browser path) are also configurable, in `wxt.config.ts`, `web-ext.config.ts`, or `$HOME/web-ext.config.ts`. (https://wxt.dev/guide/essentials/config/browser-startup.html)
- **`wxt build` output**: builds to `.output/<browser>-mv3/` (e.g. `.output/chrome-mv3/`), directly loadable via chrome://extensions "Load unpacked" — confirmed present in both sibling projects' `.output/chrome-mv3/`.
- **`browser` polyfill vs `chrome` global**: **As of WXT 0.20.0, `webextension-polyfill` was removed** from WXT's `browser` object — it's now purely typed access to the native `chrome.*` API (types come from `@wxt-dev/browser`, not `webextension-polyfill`). `browser.runtime.onMessage` no longer supports returning a Promise for a response — use `sendResponse`. For a Chrome-only MV3 extension, `browser` (from `#imports`) and `chrome` are functionally interchangeable; `browser` only buys you types/auto-import convenience, not a Firefox-compatibility abstraction. (https://wxt.dev/guide/resources/upgrading.html)
- **Deprecated in current major (0.21.x)**: `wxt.config.runner` → `webExt`; `dev.server.hostname` → `dev.server.host`; the `wxt/testing` barrel export (import submodules directly, e.g. `wxt/testing/fake-browser`); `clean(root: string)` string overload; `url:` imports removed entirely. `vite`, `web-ext`, and `typescript` moved from regular deps to **peerDependencies** — must be installed explicitly. Minimums: Node ≥22, Vite ≥6.3.4 (dropped v5), TypeScript ≥5.4, `web-ext` ≥9.2.0.

## 2. Messaging

| Option | Version | Stars | Last activity | Status |
|---|---|---|---|---|
| `@webext-core/messaging` | 4.0.0 (2026-07-25) | 333★ (whole webext-core monorepo) | repo pushed 2026-08-08, 5 open issues | active, small |
| `webext-bridge` | npm 6.0.1 (published 2023-04-07) | 712★ | repo pushed 2026-05-10 (commits w/o release) | **stale on npm** — 3+ years since last publish despite repo activity |
| `comlink` | 4.4.2 (2024-11-07) | 12,791★, not archived | repo pushed 2026-08-11 | active but general RPC-over-postMessage/proxy tool, not extension-messaging-specific |
| plain `chrome.runtime.Port` + typed wrapper | n/a (write it) | n/a | n/a | recommended |

Read `@webext-core/messaging@4.0.0`'s actual dist source (`generic-*.mjs`, ~80 lines): `defineExtensionMessaging()` returns `{ sendMessage, onMessage, removeAllListeners }`. `sendMessage` posts a `{id, type, data, timestamp}` envelope through `browser.runtime.sendMessage`/`onMessage` and awaits exactly one `{res}`/`{err}` reply; `onMessage(type, handler)` registers **one listener per type per JS context** (a second call for the same type throws). There is **no stream/subscription/event-emitter API** in the package — it is pure request/response, confirmed by source, not just the README.

**For a service worker streaming many run-log events to a side panel, surviving SW restarts**: recommend **`chrome.runtime.connect`/`onConnect` (long-lived `Port`)** with a small typed wrapper (~40 lines: `port.postMessage({type, seq, payload})`, an `onDisconnect` handler that reconnects with backoff, and a sequence number so the panel can request replay of missed events after a SW restart — SW restarts *will* drop an open `Port`, so the wrapper, not the browser, is what must handle "control moving between Leader/Follower" continuity for R-07). Use `@webext-core/messaging` alongside it for one-shot commands (e.g. "start run", "cancel") where request/response is the right shape — the two are complementary, not competing.

## 3. Storage

- **WXT `storage` API** (`@wxt-dev/storage@1.2.9`, a direct dependency of `wxt` itself, importable via `#imports`): typed, schema'd storage items with versioning/migration helpers over `chrome.storage.local/session/sync`. Good fit for settings, per-role model selection (R-11), and small config — not for a growing run log.
- **`@webext-core/storage@2.0.0`** (2026-07-25): a smaller, framework-agnostic, localStorage-esque typed wrapper from the same webext-core monorepo — functionally overlaps with WXT's own `storage`; **use WXT's built-in one** since it ships free and is already a WXT dependency (avoids adding a redundant package).
- **`idb@8.0.3`** (2025-05-07, 7,402★, 57 open issues, actively used): thin Promise wrapper over IndexedDB. Recommended for **run logs and checkpoints** — IndexedDB has no practical 10MB ceiling and handles many small appended records far better than `chrome.storage`.
- **Quotas** (https://developer.chrome.com/docs/extensions/reference/api/storage): `chrome.storage.local` — 10MB (`QUOTA_BYTES` 10,485,760; was 5MB in Chrome ≤113); the `unlimitedStorage` permission removes this cap. `chrome.storage.session` — also 10MB in-memory (was 1MB pre-Chrome-111), cleared on extension reload/browser restart; **not exposed to content scripts by default** (call `setAccessLevel()` to change). `chrome.storage.sync` is capped much lower (~100KB total, out of scope here — don't use it for run data).

## 4. Tool-call transcript UI (R-06)

| Candidate | Stars | Last release/push | Adoption / dependency weight | AI-SDK coupling |
|---|---|---|---|---|
| **shadcn/ui** | 122,936★ | pushed 2026-09-03 | copy-in components, not an npm dependency; you own the code | none — framework-agnostic |
| **Radix primitives** (e.g. `@radix-ui/react-dialog@1.1.23`, `-collapsible@1.1.20`, `-tabs@1.1.21`, `-scroll-area@1.2.18`) | large ecosystem, per-package | stable channel active Jul–Sep 2026, 1.2.0 in RC | unstyled, accessible primitives — shadcn's foundation | none |
| **Vercel AI Elements** (elements.ai-sdk.dev) | rides on `vercel/ai` (26,567★, pushed 2026-09-03) | active | a **shadcn registry** (installed via `npx shadcn add <url>`, copy-paste components, not an npm package) | components are built "with deep integration with the AI SDK" (streaming/status states) but are plain React+Tailwind+Radix under the hood — usable with custom event/data types by adapting props, at the cost of manually reimplementing the streaming-status wiring AI SDK's `useChat`/`UIMessage` normally provides |
| **`assistant-ui`** | 11,996★ | pushed 2026-09-03, v0.0.114 (still pre-1.0 after 114 releases) | full framework-y runtime (its own message/thread state model) | tightly coupled to its own primitives | **user already rejected this** ("assistant ui don't fit us") |

**Recommendation**: **plain shadcn/ui + Tailwind + Radix**, hand-building `Tool`/`Reasoning`/`Conversation`/timeline components **modeled on** AI Elements' patterns (their source is MIT/open and readable at the registry URL) but wired directly to our own event schema (tool-call started/streaming/finished, Leader↔Follower handoff events) rather than the AI SDK's `UIMessage`. This satisfies C-04 (adopted, widely-used primitives, read not guessed) and N-03 (no app framework — Radix + shadcn is explicitly allowed) while avoiding both the AI-SDK lock-in of AI Elements and the already-rejected `assistant-ui`.

## 5. Tailwind v4 + React 19 with WXT

- **`tailwindcss@4.3.3`** and **`@tailwindcss/vite@4.3.3`** (matched versions, both current) integrate as a plain Vite plugin — no `postcss.config.js`/`tailwind.config.js` needed (CSS-first config via `@import "tailwindcss"` + `@theme`), simpler than the `nanobrowser-next` sibling's v3 setup (`tailwindcss@^3.4.4` + `postcss.config.js` + `tailwind.config.js`), which predates this research and should be upgraded.
- **React 19.2.8** (current stable) works with WXT's official React module `@wxt-dev/module-react@1.2.2`, whose only peer constraints are `vite: ^5.4.19 || ^6.3.4 || ^7.0.0 || ^8.0.0-0` and `wxt: >=0.19.16` — no React version pin, so 18 or 19 both work; recommend 19 for a greenfield build.

## 6. Vitest / MV3 test setup

- **Vitest 5.0.0 released 2026-09-03 (today)** — same-day release, Vite ≥6.4.0 and Node ≥22.12.0 required, breaking changes include `clearMocks: true` by default, strict locators, and async assertions must be awaited (https://vitest.dev/blog/vitest-5). **Too new to pin on day one of a greenfield project** — recommend **`vitest@4.1.11`** (2026-08-18, the last mature v4 patch) and revisiting 5.0 after the ecosystem (coverage-v8, WXT's own vitest usage) confirms compatibility.
- **`vitest-chrome`**: single release, `0.1.0`, 2023-08-25, never updated — **dead, do not use**.
- **`@webext-core/fake-browser@2.0.1`** (2026-07-26 publish, part of the active webext-core monorepo): in-memory `chrome`/`browser` API implementation for tests, explicitly supports Vitest/Jest. **WXT bundles this directly** — `wxt`'s own dependency list includes `@webext-core/fake-browser": "^2.0.1"`, and `wxt/testing/fake-browser` is a two-line re-export of it (confirmed by reading the installed package). So no extra dependency is needed if WXT is already in use.
- **How sibling attempts actually tested MV3 code** (read directly from local sibling repos `nanobrowser-next` and `nanobrowser-opencode`, both WXT + `@webext-core/messaging@^2.2.0` + `vitest`): neither mocks `chrome.*` for its core logic tests. Both put a `BrowserPort` interface between agent logic and the extension APIs, with a `FakeBrowserPort` in-memory implementation (`src/browser-port/fake.ts`) driving pure unit tests (`tests/browser-port.test.ts`, `tests/agent-executor.test.ts`) — zero `chrome` mocking required. Chrome/CDP is only touched in a separate, explicit e2e test (`tests/e2e/cdp-qualification.test.ts`) that spawns real headless `chromium` with `--remote-debugging-port` and drives it over the raw CDP HTTP/WS protocol.
- **Recommendation**: 
  - **Service-worker/agent logic**: keep the sibling projects' seam pattern — a small `BrowserPort`/`ChromeGateway` interface, a `Fake*` in-memory implementation for unit tests, real WXT-generated code behind it. Use `wxt/testing`'s `fakeBrowser` (i.e. `@webext-core/fake-browser`) only for the thin adapter layer that actually calls `chrome.*`, not for business logic.
  - **React panel code**: `vitest` + `@testing-library/react` + `jsdom` (jsdom 30.0.1, current) or `happy-dom` (20.13.2, current, lighter/faster) as the DOM env — either is fine; `happy-dom` is faster for a component-heavy panel.
  - **True Chrome-only behavior** (side panel lifecycle, `chrome.debugger`, `chrome.userScripts` toggle behavior): a small number of CDP-driven or Playwright-with-extension e2e tests, run separately from the fast unit suite, exactly as `cdp-qualification.test.ts` already does.

## 7. Recommended `package.json` dependencies

```jsonc
{
  "dependencies": {
    "react": "19.2.8",                    // UI runtime (N-03: framework-adjacent, not an app framework)
    "react-dom": "19.2.8",                // React DOM renderer, matched version
    "@webext-core/messaging": "4.0.0",    // typed request/response one-shot commands (start/cancel run)
    "zod": "4.5.4",                       // schema validation for tool-call payloads / storage items
    "clsx": "2.1.1",                      // conditional className composition (shadcn convention)
    "tailwind-merge": "3.6.0",            // merges conflicting Tailwind classes (shadcn convention)
    "class-variance-authority": "0.7.1",  // shadcn's variant-prop pattern for component styling
    "lucide-react": "1.40.0",             // icon set shadcn/ai-elements patterns use
    "@radix-ui/react-dialog": "1.1.23",   // modal/confirm primitives (unstyled, accessible)
    "@radix-ui/react-collapsible": "1.1.20", // collapsible tool-call input/output panels
    "@radix-ui/react-tabs": "1.1.21",     // role/model tabs in the panel
    "@radix-ui/react-scroll-area": "1.2.18", // scrollable run-log timeline
    "idb": "8.0.3"                        // IndexedDB wrapper for run logs & checkpoints
  },
  "devDependencies": {
    "wxt": "0.21.4",                      // MV3 build/dev framework: sidepanel entrypoint, manifest gen, HMR
    "@wxt-dev/module-react": "1.2.2",     // official WXT React integration
    "vite": "8.2.2",                      // satisfies wxt's peerDependency range (^6.3.4||^7||^8.0.0-0)
    "web-ext": "9.2.0",                   // satisfies wxt's peerDependency (>=9.2.0), drives dev-mode browser launch
    "typescript": "5.9.3",                // latest 5.x stable satisfying wxt's >=5.4 peerDependency (avoid 7.x nightly)
    "tailwindcss": "4.3.3",               // CSS-first Tailwind v4
    "@tailwindcss/vite": "4.3.3",         // Vite-native Tailwind plugin, no postcss config needed
    "@types/chrome": "0.2.8",             // chrome.* type definitions
    "@types/react": "19.2.x",             // match react major
    "@types/react-dom": "19.2.x",         // match react-dom major
    "vitest": "4.1.11",                   // pinned mature v4; v5.0.0 shipped today, revisit later
    "@testing-library/react": "latest",   // React component testing
    "happy-dom": "20.13.2",               // fast DOM env for panel component tests
    "@webext-core/fake-browser": "2.0.1"  // explicit pin even though wxt bundles it, for direct test imports
  }
}
```

Notes: `vite`, `web-ext`, and `typescript` **must** be explicit devDependencies as of WXT 0.21 (they moved from WXT's own deps to peerDependencies). `@ai-sdk/*` / `ai` packages are deliberately **not** included — the UI intentionally avoids AI-SDK `UIMessage` coupling per the recommendation in §4.

## Risks

- **Vitest 5.0.0 same-day release** (2026-09-03): pinning 4.1.11 avoids day-one breakage, but the project will need to re-evaluate the 4→5 migration path within weeks, since v4 will stop receiving fixes eventually.
- **`webext-bridge` and `vitest-chrome` are both effectively dead** — do not let either enter the dependency tree transitively; verify with `npm ls` after install.
- **Hand-rolled `Port` wrapper is the one piece of "custom infrastructure"** in this stack (everything else is adopted, per C-04) — because no evaluated messaging library (`@webext-core/messaging`, `webext-bridge`, `comlink`) offers a maintained, SW-restart-aware event stream. Keep this wrapper small (~40 lines) and unit-test it directly with `FakeBrowserPort`-style fakes, since it is the part most likely to hide subtle bugs in R-07 (live run log across Leader/Follower handoff).
- **`debugger` permission** will draw Chrome Web Store review scrutiny and shows a persistent "is debugging this browser" banner to users while active — budget for a clear runtime justification string and consider gating it behind an explicit user opt-in setting rather than requesting it unconditionally at install.
- **`userScripts` requires a user-flipped toggle** Chrome does not surface prominently (buried in Developer Mode pre-138, or a per-extension toggle 138+) — any userscript-dependent feature needs an in-panel readiness check (`chrome.userScripts` undefined-check) and clear onboarding UI, not just a manifest permission.
- **AI Elements' exact source/props were not fully readable** from the fetched overview page (redirect + summarized fetch) — before porting its `Tool`/`Reasoning` components, pull the actual component source from the shadcn registry URL and read it directly rather than relying on this summary.
