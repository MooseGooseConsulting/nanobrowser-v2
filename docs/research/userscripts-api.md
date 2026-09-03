# Executing & Debugging Userscripts Live from an MV3 Extension

Research date: 2026-09-03. All claims verified against Chrome docs, Chromium source/issue tracker, WECG proposals, and OSS userscript-manager source as of this date.

## Answer-first summary

1. `chrome.userScripts` (register/update/unregister/getScripts/configureWorld) shipped Chrome 120; `worldId`+`getWorldConfigurations`+`resetWorldConfiguration` shipped Chrome 133; `execute()` shipped Chrome 135 — this is exactly R-09's live-exec primitive.
2. `userScripts.execute()` accepts `js:[{code:'...'}]` (arbitrary string) and returns `Promise<InjectionResult[]>` with per-frame `result`/`error` — `scripting.executeScript` only accepts a `func` (serialized function, no arbitrary strings) and cannot inject unregistered dynamic code as flexibly.
3. `USER_SCRIPT` world is explicitly exempt from the page's CSP; `MAIN` world runs "regardless of the page's CSP" for the injection itself, but anything the injected code *creates* (a `<style>`, another `<script>` tag) is still subject to the page's CSP — confirmed by a Chrome extensions engineer on the WECG PR thread.
4. Both Chrome and Firefox still gate `chrome.userScripts`/`browser.userScripts` behind a user-facing toggle: Developer Mode pre-Chrome-138, a per-extension "Allow User Scripts" toggle from Chrome 138+ (one-time auto-migration on upgrade); the API is `undefined` when off (Chrome 138+) vs. throws (pre-138).
5. Console/error capture requires patching `console`, `window.onerror`, and `window.onunhandledrejection` **inside the MAIN world** — an ISOLATED/content-script patch never sees the page's real console/errors, because isolated worlds don't share JS objects with the page.
6. Best transport for results: `messaging:true` via `configureWorld` + `runtime.sendMessage`/`onUserScriptMessage` works only from the `USER_SCRIPT` world (MAIN world has zero `chrome.*` access) — so a MAIN-world harness must bridge via `window.postMessage`/`CustomEvent` to an ISOLATED content script, which then relays to the background via `runtime.sendMessage`.
7. `userScripts.execute()`'s own return value already gives you the script's final expression/promise result and any *uncaught synchronous* top-level throw (as `InjectionResult.error`) — but it does **not** capture `console.*` calls or async unhandled rejections that occur after the script's own promise settles; you still need the in-page harness for R-10's "capture everything" requirement.
8. `chrome.runtime.sendMessage` messages are capped at 64 MiB (JSON-serialized in Chrome; opt-in structured clone lands in Chrome 148) — plenty for console/error payloads, but cap+truncate large args defensively.
9. Real userscript managers (ScriptCat, Violentmonkey, Tampermonkey) all converged on the same pattern: register a MAIN-world "inject" bundle + a USER_SCRIPT-world "content" bundle, `configureWorld({messaging:true, csp:...})` once, and re-register/`update()` on every edit — this is the concrete precedent for "edit and re-run in place."
10. `chrome.debugger` (CDP `Runtime`/`Log` domains) gives real breakpoints/console capture but permanently shows a non-dismissable "... started debugging this browser" infobar — this fails R-02 (low observability) outright.
11. I-03 is valid but only partially escapes the trusted-input problem: a MAIN-world `fetch(url, {credentials:'include'})` reuses the page's own cookie jar and (same-origin) is bound by the page's `connect-src` CSP just like the page's own code — it does not bypass CSRF tokens (same-origin fetch never needed to), but it also doesn't help against SameSite/HttpOnly restrictions since the script still can't read HttpOnly cookies.
12. Recommendation: use `userScripts.execute()` with `world:'MAIN'` for live exec, an injected-harness pattern (unique run-id, console patch, error/rejection listeners, CustomEvent bridge to an always-present ISOLATED content script) for capture, and treat `chrome.debugger` as out of scope per R-02.

---

## 1. `chrome.userScripts` API surface & version history

| Member | Chrome version | Notes |
|---|---|---|
| `register()`, `update()`, `unregister()`, `getScripts()`, `configureWorld()` | 120 | Core dynamic-registration API for MV3, replacing MV2 `content_scripts` for user-provided code. |
| `worldId` on `RegisteredUserScript`/`WorldProperties`, `getWorldConfigurations()`, `resetWorldConfiguration()` | 133 | Lets each userscript run in its own isolated `USER_SCRIPT` world instead of one shared world. Announced by the Chrome extensions team together with Firefox/Safari/Edge engineers via WECG. |
| `execute()` | 135 (stable; behind `--enable-features=ApiUserScriptsExecute` in Canary from ~134) | One-off, non-persistent injection — the "run this now" primitive R-09 needs. Returns `Promise<InjectionResult[]>`. |

Sources: https://developer.chrome.com/docs/extensions/reference/api/userScripts , https://developer.chrome.com/docs/extensions/whats-new (Chrome 135 entry, posted 2025-03-17), https://groups.google.com/a/chromium.org/g/chromium-extensions/c/oEo-Jm0EqsY (PSA: `execute()` + multi-world support, Chrome 133 stable / 135 for `execute`), Chromium CL implementing `execute()`: https://chromium.googlesource.com/chromium/src/+/4dfb837c1d43639e18d7d8d1ba83f0faec55ea30 , proposal doc: https://github.com/w3c/webextensions/blob/main/proposals/user-scripts-execute-api.md

**Script source**: `ScriptSource` requires exactly one of `code` (inline string) or `file` (path relative to extension root).

**Worlds**: `world: 'USER_SCRIPT'` (default) or `'MAIN'`. `worldId` (Chrome 133+) is only valid when `world` is `USER_SCRIPT` or omitted — not valid for `MAIN`.

**`configureWorld({csp, messaging, worldId})`**: `messaging:true` (default `false`) is required for a `USER_SCRIPT`-world script to call `chrome.runtime.sendMessage()`/`connect()`; the extension receives these via the dedicated `runtime.onUserScriptMessage`/`onUserScriptConnect` handlers, not the normal `onMessage`. `csp` overrides the default (ISOLATED-world-equivalent) CSP for that world — e.g. set `"script-src 'unsafe-eval' 'unsafe-inline' 'self' *"` to allow `eval()` inside `USER_SCRIPT` world (this is what ScriptCat does, see §5).
Source: https://developer.chrome.com/docs/extensions/reference/api/userScripts

### The "Allow User Scripts" toggle (Chrome 138 change)

- **Chrome < 138**: requires the global **Developer Mode** toggle at `chrome://extensions`. Accessing `chrome.userScripts` **throws** if off.
- **Chrome ≥ 138**: requires a **per-extension "Allow User Scripts"** toggle on the extension's details page (`chrome://extensions/?id=<id>`). If off, `chrome.userScripts` is **`undefined`** (not a throw) — this undefined state only clears when the extension's script context reloads.
- **Migration**: on first launch of Chrome 138+, a **one-time migration** auto-enables the new toggle for any extension that already had the `userScripts` permission granted *and* Developer Mode was on; extensions installed after the migration default to **off**.
- Recommended cross-version availability check (from Chrome's own docs):
  ```js
  function isUserScriptsAvailable() {
    try { chrome.userScripts.getScripts(); return true; }
    catch { return false; }
  }
  ```
- Enterprises: `blocked_permissions` policy / Google Admin console now controls this instead of disabling Developer Mode wholesale.

Sources: https://developer.chrome.com/blog/chrome-userscript (2025-05-29 announcement), https://developer.chrome.com/docs/extensions/reference/api/userScripts (toggle-detection section + copy-pasteable end-user instructions), migration implementation: https://github.com/chromium/chromium/commit/ba6541dbdc79af70937fb39800321af98de6297b , tracking bug: https://issues.chromium.org/issues/390138269

**Real-world confirmation this is still a UX problem**: ScriptCat's production code (`src/app/service/service_worker/runtime.ts`) branches on browser type to decide whether to show "enable developer mode" vs. "allow user scripts" onboarding UI, and Violentmonkey's maintainer publicly said (2024) they were "reluctant to work on the new API" specifically because of this opt-in requirement. Sources: https://github.com/scriptscat/scriptcat/blob/125d58b5/src/app/service/service_worker/runtime.ts , https://github.com/violentmonkey/violentmonkey/issues/1934

---

## 2. `userScripts.execute()` vs `scripting.executeScript({world:'MAIN'})`

| | `userScripts.execute()` | `scripting.executeScript()` |
|---|---|---|
| Arbitrary code string | **Yes** — `js:[{code:'...'}]` | **No** — `func` must be a real function reference, serialized/deserialized; only `args` (JSON-serializable) can carry data in |
| Worlds | `USER_SCRIPT` (default) or `MAIN` | `ISOLATED` (default) or `MAIN` |
| CSP on injection itself | `USER_SCRIPT`: exempt from page CSP by design. `MAIN`: the *injection* still runs "regardless of the page's CSP" per Chrome engineering clarification, but DOM/resources the code subsequently creates (inline `<style>`, `<script src>`, `eval` if page CSP forbids it) remain governed by the page's CSP | `MAIN`: same rule — code runs, but constructs it makes are still CSP-governed. Chrome docs give no separate CSP carve-out for `scripting` MAIN world (it was never exempt) |
| Return value | `Promise<InjectionResult[]>`, one per frame: `{documentId, frameId, result?, error?}`. If the script evaluates to a Promise, Chrome **awaits it** and returns the settled value | Same `InjectionResult[]` shape, one per frame, `result` is the function's return value |
| `injectImmediately` | Supported — bypasses waiting for `document_idle` | Supported — same semantics, "not a guarantee" of pre-load execution |
| Frames | `target.frameIds` / `target.documentIds` / `target.allFrames` | `frameIds` / `allFrames` (mutually exclusive) |
| Permission model | Requires `userScripts` permission + the Allow-User-Scripts/Dev-Mode toggle (see §1) | Requires `scripting` permission only — no extra user toggle |
| Policy posture | Explicitly carved out of Chrome's Remote Hosted Code policy — designed for genuinely dynamic/user-authored code | A Chrome engineer explicitly said using `scripting.executeScript` MAIN-world string-eval tricks "looks very similar to circumventing remote hosted code restrictions" and discouraged it |

Sources: https://developer.chrome.com/docs/extensions/reference/api/userScripts , https://developer.chrome.com/docs/extensions/reference/api/scripting , WECG PR clarifying MAIN-world CSP behavior (Emilia Paz / Chrome extensions team, 2024): https://github.com/w3c/webextensions/pull/540 , chromium-extensions group thread on `eval()`/CSP/remote-code policy: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/W2J8_81NzkM

**Practical implication for R-09**: `userScripts.execute({world:'MAIN', js:[{code: userSuppliedString}]})` is the only Chrome-native primitive that (a) takes an arbitrary string, (b) runs in the page's real JS context, and (c) returns a structured async result — this is the correct primitive to build R-09 on.

---

## 3. Console/error capture options

Four options were investigated:

**A. In-page harness (recommended)** — wrap the injected code in an IIFE that:
1. Generates a unique `runId`.
2. Monkey-patches the five `console` methods (bind natives first, call through so page behavior is unaffected) and buffers `{level, args, ts}`.
3. Adds `window.addEventListener('error', ...)` and `window.addEventListener('unhandledrejection', ...)` (capture-phase, don't call `preventDefault`) tagged with `runId`.
4. Ships buffered events out via `window.postMessage`/`CustomEvent` (see next point) rather than trying to call `chrome.runtime` directly (MAIN world has no `chrome.*` access at all).

This must run **in the MAIN world**, not the default ISOLATED/USER_SCRIPT world — a content script's `console`/`window` are its own private copies (isolated-world semantics), so patching them there captures nothing the page itself emits. Confirmed explicitly by Chrome's own docs language ("JavaScript variables in an extension's content scripts are not visible to the host page") and demonstrated end-to-end in a MAIN-world capture write-up. Source: https://www.bugmojo.com/blog/engineering/capturing-console-and-network-without-an-sdk , general isolated-world doc: https://developer.chrome.com/docs/extensions/reference/api/userScripts

**B. `messaging:true` + `chrome.runtime.sendMessage` from the script itself** — only available in the `USER_SCRIPT` world (via `runtime.onUserScriptMessage`), **not** in `MAIN` world (MAIN world literally shares the page's JS environment and has zero extension API surface). So if R-09 needs `world:'MAIN'` (to see/mutate the page's real globals), this option alone can't ship results — you still need the CustomEvent bridge below to get out of MAIN world first.

**C. CustomEvent bridge to an always-injected ISOLATED content script** — the pattern every production userscript manager uses (Violentmonkey's `SafeCustomEvent`/vault handshake, ScriptCat's `pageAddEventListener`/`pageDispatchEvent`). A permanently-registered ISOLATED-world content script listens for a uniquely-named `CustomEvent`; the MAIN-world harness dispatches captured console/error events on it; the content script relays to the background via normal `runtime.sendMessage`. This is the only path that supports MAIN-world code while still reaching the extension, and it avoids `chrome.debugger`'s infobar. Sources: https://deepwiki.com/violentmonkey/violentmonkey/4.1-injection-architecture , https://github.com/scriptscat/scriptcat/blob/125d58b5/src/app/service/content/script_executor.ts

**D. `chrome.debugger` (CDP `Runtime`/`Log` domains)** — gives you `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, real breakpoints via `Debugger.*`. Rejected for this use case: attaching shows a **permanent, non-dismissable "‘Extension’ started debugging this browser" infobar** that only Chrome itself can auto-hide (and only ≥5s after detach) — this is a hard fail against R-02 (low observability). `--silent-debugger-extension-api` suppresses it but is a launch flag the end user's Chrome won't have. Sources: https://developer.chrome.com/docs/extensions/reference/api/debugger , https://stackoverflow.com/questions/63441002/chrome-extension-clear-infobar-label-after-debug-mode

**Tampermonkey's real-world console-override bug** confirms this pattern is nontrivial to get right: overriding `console.error` inside their MAIN-world-like environment initially threw `TypeError: Cannot set property error of [object Object] which has only a getter` for consumers like React DevTools; fixed in Tampermonkey 5.4.6225 by making the override properly writable/configurable. Source: https://github.com/Tampermonkey/tampermonkey/issues/2330

---

## 4. Structured return values from `userScripts.execute()`

- `InjectionResult { documentId, frameId, result?, error? }`, one entry per targeted frame — same shape family as `scripting.executeScript`'s `InjectionResult`.
- **Async supported**: "If the script evaluates to a promise, the browser will wait for the promise to settle and return the resulting value" — so a top-level `async` IIFE's resolved value comes back in `result`, and a top-level *rejection* comes back in `error`.
- **What it does NOT give you**: `console.*` calls made during execution, or errors/rejections that occur *after* the top-level promise has already settled (e.g. a `setTimeout` callback that throws later, or an event listener that rejects asynchronously) — those require the in-page harness from §3, shipped out via message passing rather than the `execute()` return value.
- **Size/transport limits**: the `execute()` return path itself goes through the extension bindings, same message-size rules as any other extension IPC. Separately, if you ship supplementary telemetry via `chrome.runtime.sendMessage` (per §3), Chrome's message-passing docs state a **64 MiB max message size** (JSON-serialized by default in Chrome, unlike Firefox's structured clone). An **opt-in structured-clone serialization mode** (via a manifest flag) is landing in **Chrome 148**, letting `Map`/`Set`/`Date`/`Blob`/etc. cross without manual (de)serialization — not required for console/error capture (all JSON-safe) but useful if you want to ship `Error` objects, `Map`s, etc. natively later.

Sources: https://developer.chrome.com/docs/extensions/reference/api/userScripts , https://developer.chrome.com/docs/extensions/develop/concepts/messaging , https://developer.chrome.com/blog/structured-clone-messaging (Chrome 148 structured-clone opt-in)

---

## 5. "Edit and re-run in place" — prior art from OSS userscript managers

All three major managers converged on the same MV3 shape: a **MAIN-world "inject" bundle** + a **USER_SCRIPT-world "content" bundle**, registered together, plus a one-time `configureWorld({messaging:true, csp:...})` call, then `register()`/`update()`/`unregister()` cycles as scripts change.

**ScriptCat** (`scriptscat/scriptcat`, MIT-ish, active MV3 implementation):
- Registers `scriptcat-inject` (world `MAIN`) and `scriptcat-content` (world `USER_SCRIPT`) as two separate `RegisteredUserScript`s covering `<all_urls>`, then falls back per-script `register()`/`update()` for individual user scripts, retrying with `update()` on "Duplicate script ID" errors — a direct idempotent re-register pattern.
  File: https://github.com/scriptscat/scriptcat/blob/125d58b5/src/app/service/service_worker/runtime.ts
- Configures the `USER_SCRIPT` world with a permissive CSP (`"script-src 'self' 'unsafe-inline' 'unsafe-eval' *"`) plus `messaging:true`, with a fallback to `messaging:true` alone if the CSP-inclusive call fails (older/stricter Chrome builds). Same file as above (`getContentAndInjectScript`).
- `ExecScript.stop()` is an explicit **stop hook** per running script instance, and `execScriptMap: Map<uuid, ExecScript>` tracks live instances — the concrete "cleanup previous instance via a global stop hook" pattern.
  File: https://github.com/scriptscat/scriptcat/blob/125d58b5/src/app/service/content/exec_script.ts
- Idempotency guard: `window['<flag>']=function(){}` marker left behind after a script's body runs, checked before re-execution to detect duplicate injection.
  File: https://github.com/scriptscat/scriptcat/blob/125d58b5/src/app/service/content/utils.ts (see `compileScriptletCode`)
- Architecture overview (Path A: page scripts → `chrome.userScripts`, MAIN or USER_SCRIPT world by `@inject-into`): https://github.com/scriptscat/scriptcat/blob/main/docs/ARCHITECTURE.md

**Violentmonkey** (`violentmonkey/violentmonkey`, still MV2-primary; MV3 branch/PR in progress as of late 2025):
- Its MV3 injection design (documented via DeepWiki, sourced from the live repo) uses a "Vault" system in the MAIN-world sandbox to protect extension globals from page tampering, with unique per-injection `vaultId`/`handshakeId` and a `handshaker` DOM-event confirmation before real script execution begins — directly relevant to "unique run id" style patterns.
  https://deepwiki.com/violentmonkey/violentmonkey/4.1-injection-architecture
- A maintainer explicitly noted `userScripts.execute()` "doesn't guarantee `document-start` execution before any other page scripts can run" — a real limitation to design around if strict pre-page-script ordering matters (it generally doesn't for R-09/R-10's "already-open tab" case).
  https://github.com/violentmonkey/violentmonkey/pull/2399
- Before `execute()` existed, their documented workaround for on-demand run was `configureWorld({csp:"script-src 'unsafe-eval' 'unsafe-inline' 'self'"})` + a `register()`-ed controller script that either `eval()`s or injects a `<script>` element on message receipt.
  https://github.com/violentmonkey/violentmonkey/discussions/2135

**Tampermonkey** (`Tampermonkey/tampermonkey`, closed-source but discussion issue is public): shipped an MV3 beta using `chrome.userScripts`, with "UserScripts API Dynamic" mode injecting at `document_start` into all frames and post-filtering by regex (since the native API only supports match-patterns/globs, not regex) — relevant if R-09/R-10 ever need regex-style targeting beyond `matches`/`includeGlobs`.
  https://github.com/Tampermonkey/tampermonkey/issues/644

**Reference (Mozilla) minimal implementation** — `mdn/webextensions-examples` ships a from-scratch userscript-manager example showing `parseUserScript()` (metadata → `RegisteredUserScript`, including the `world`/`worldId` choice based on whether any `@grant` is requested) and `handleUserScriptMessage()` (the `onUserScriptMessage` handler side of `messaging:true`). Good minimal-surface reference implementation to build R-09/R-10 against.
  https://github.com/mdn/webextensions-examples/blob/main/userScripts-mv3/userscript_manager_logic.mjs

**Recommended re-run pattern for R-10** (synthesized from the above):
1. On "run"/"re-run", generate a fresh `runId`.
2. Call any previous run's exposed `window.__stopHooks?.[prevRunId]?.()` (idempotent — no-op if absent) before injecting again — mirrors ScriptCat's `ExecScript.stop()`.
3. `userScripts.execute({target:{tabId}, world:'MAIN', js:[{code: harness(runId, userCode)}]})` where `harness()` wraps user code with the console/error capture from §3 and registers a new stop hook under `window.__stopHooks[runId]`.
4. Collect `InjectionResult` for the synchronous/promise return value; collect streamed console/error events via the CustomEvent bridge (§3-C) keyed by `runId` so results from stale runs are discardable/ignorable by the extension.

---

## 6. I-03 — routing around trusted-input via the page's own APIs

A MAIN-world script (via `userScripts.execute({world:'MAIN'})`) runs **as the page itself** — so:

- `fetch(url, {credentials:'include'})` (or the fetch default of `'same-origin'`, which already sends cookies for same-origin requests) sends the browser's real, non-HttpOnly *and* HttpOnly cookies exactly as the page's own code would — no synthetic input, no simulated clicks/typing needed. Confirmed pattern in a real capability-scoped extension: `fetch(url, {credentials:'include'})` from the page MAIN world "does NOT navigate the tab," is safe from a redirect-hijack standpoint, and correctly reuses the page's cookie jar.
  https://github.com/chrischall/fetchproxy/blob/main/docs/SECURITY.md
- **Reading the page's own JS globals/stores** (Redux store, a global `window.__APP_STATE__`, an in-memory API client instance) is trivial from MAIN world since it *is* the page's JS environment — no message-passing or serialization needed, unlike ISOLATED-world content scripts which cannot see page JS objects at all.
- **CSP `connect-src` still applies**: a MAIN-world `fetch()` is executed by the page's own JS engine, so it is bound by the page's CSP `connect-src` directive exactly like the page's own fetch calls — the userScripts CSP exemption applies to the *injection* of code, not to what that code subsequently does via standard web platform APIs governed by the page's own CSP. If the target endpoint isn't already an allowed `connect-src`, this same-origin app-internal call typically still works because it's the page's *own* first-party API (same origin ⇒ almost always allowed even under strict `connect-src 'self'`).
  https://content-security-policy.com/connect-src/ , general CSP-by-context table: https://github.com/samber/cc-skills/blob/main/skills/chrome-extension/references/network-csp.md
- **CSRF tokens are not a problem, they're the point**: calling the page's own internal API the same way the page's own JS would means any CSRF token the page embeds in `window.__CSRF_TOKEN__`/a meta tag/a hidden input is already legitimately readable from MAIN world (the page exposes it to its own scripts anyway) — same-origin fetch from MAIN world is indistinguishable from the page doing it itself.
  https://github.com/chrischall/fetchproxy/blob/main/docs/SECURITY.md (T7 — CSRF token exposure discussion)
- **HttpOnly cookies remain invisible to `document.cookie`** but are still automatically attached by the browser to a same-origin `fetch(..., {credentials:'include'})` call — this is standard browser cookie-jar behavior, not something the extension needs to work around; it only matters if you try to *read* the session cookie value directly (you can't, by design).
- **SameSite**: irrelevant here since these are same-origin requests from the page itself — `SameSite=Lax/Strict` restrictions govern *cross-site* requests, not the page calling its own same-origin API.

**Conclusion on I-03**: Yes — calling the page's own `fetch`/internal API from a MAIN-world script legitimately routes around needing to synthesize UI input (clicks/typing) for read/write operations the page's own JS could do, and it inherits the page's real auth context "for free." It does **not** bypass CSP `connect-src` restrictions on *cross-origin* calls, and it doesn't grant access to HttpOnly cookie values themselves (though the browser will still send them). This is a solid, low-noise complement to R-09's direct-code-execution capability, not a replacement for it.

---

## 7. Firefox parity (brief)

Firefox's `browser.userScripts` API is essentially aligned with Chrome's design (same WECG proposal, co-designed with Firefox/Safari/Edge engineers):
- Same `USER_SCRIPT`/`MAIN` world split; `configureWorld({csp, messaging})`; per-script `worldId` isolation.
- One documented divergence: `worldId` is **not supported for `MAIN` worlds** in Firefox's docs (same restriction Chrome imposes).
- Firefox has historically used **structured clone** for message passing generally (unlike Chrome's JSON serialization, which Chrome is only now optionally aligning via the Chrome-148 opt-in) — a minor advantage if targeting Firefox for complex message payloads.

Sources: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts , https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts/WorldProperties

---

## Recommendation

- Build R-09 on `chrome.userScripts.execute({target:{tabId}, world:'MAIN', js:[{code}], injectImmediately:true})`, guarded by the `isUserScriptsAvailable()` try/catch check (works across both pre-138 and 138+ toggle regimes).
- Build R-10's capture on an in-page MAIN-world harness (console patch + `window.onerror` + `unhandledrejection`, tagged with a per-run id) that ships events out via `CustomEvent` to a permanently-present ISOLATED content script, which relays to the background via `chrome.runtime.sendMessage` — do **not** use `chrome.debugger` (infobar violates R-02) and do **not** try to patch console from the ISOLATED/content-script side (it won't see the page's real console).
- Use `userScripts.execute()`'s own `InjectionResult.result`/`.error` for the top-level synchronous/promise outcome, and the harness's streamed events for everything else (console output, later-firing async errors) — together these satisfy R-10's "capture console output and thrown errors and unhandled rejections" requirement.
- For "edit and re-run in place," copy ScriptCat's pattern: track live instances by run id, expose a stop hook, call it before re-injecting, and use `register()`/`update()` idempotently keyed by a stable script id for anything that needs to persist across navigations (execute() itself doesn't persist, which is fine for "already-open tab" scope in R-09).
- For I-03, prefer same-origin `fetch(..., {credentials:'include'})` and reading the page's own JS state from MAIN world wherever the task allows it — it's lower-noise than synthetic input and inherits the page's real auth context, but treat it as a complement to, not a replacement for, direct code execution.

## Risks

- **Toggle friction (R-02 tension)**: both toggle regimes require a manual, visible user action in `chrome://extensions` before `userScripts` works at all — this is unavoidable Chrome policy, not something the extension can suppress, and the wording differs enough between Chrome versions (Developer Mode vs. per-extension Allow User Scripts) that onboarding copy needs a version check.
- **`execute()` timing**: does not guarantee execution before other page scripts at `document_start` — if R-09's target code depends on running before the page's own scripts initialize, this primitive alone is insufficient (Violentmonkey hit this exact limitation).
- **MAIN-world CSP leakage of created resources**: while the *injection* itself bypasses page CSP, anything the injected code creates (script tags, styles, `eval`) is still subject to the page's CSP — a script that itself calls `eval()` or constructs new `<script>` tags can still be blocked on strict-CSP sites; only the `USER_SCRIPT` world's independently configurable CSP fully escapes this.
- **Message size / serialization**: Chrome's default JSON serialization silently drops non-JSON types (functions, DOM nodes, `Map`/`Set` become `{}`) — console arguments containing such values need explicit serialization (e.g. via `util.inspect`-style stringification) before shipping over `runtime.sendMessage`; the 64 MiB cap is unlikely to bite but large captured response bodies should still be truncated defensively.
- **Console-override edge cases**: Tampermonkey's own read-only-property bug shows naive `console.method = fn` overrides can throw in some environments; use `Object.defineProperty` with `writable:true, configurable:true` or wrap rather than reassign.
- **I-03 does not bypass CORS or cross-origin CSP**: it only helps for same-origin app-internal calls; cross-origin calls the page itself couldn't make, the injected script can't make either.
- **`chrome.debugger` infobar is not just annoying, it's a hard R-02 blocker**: even a sub-100ms attach/detach cycle leaves a persistent, user-visible, non-programmatically-dismissable notification — rule this transport out entirely rather than treating it as a future breakpoints upgrade path without re-litigating R-02.
