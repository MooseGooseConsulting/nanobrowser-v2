# Live end-to-end testing in the user's real Chrome

Research date: 2026-09-03. Local: Google Chrome 152.0.7977.75, Chromium 151.0.7922.173, session type
**wayland** (Hyprland/Omarchy), `xdotool`/`ydotool` absent, `wtype` present.

Scope: the **only** end-to-end tier is the user's real, already-running Chrome against
hyperagent.com, triggered and observed without CDP. Playwright and any second launched profile are
out of scope by decision (§4).

## Answer first

1. On branded Chrome 137+ there is **no** command line, policy, or file-based way to load an
   *unpacked* extension. The first "Load unpacked" click is unavoidable.
2. After that, `chrome.runtime.reload()` from inside the extension is the only click-free reload —
   and WXT already implements it: dev-server WebSocket → `browser.runtime.reload()`, plus a
   `wxt:reload-extension` keyboard command. Set `webExt.disabled: true` so WXT does not launch its
   own throwaway Chrome; load `.output/chrome-mv3` once into the real profile.
3. `web-ext run --target chromium` always launches its own Chrome and is broken on branded
   Chrome 137+ anyway. Not usable here.
4. **Trigger the run over the existing native-messaging host.** The extension calls `connectNative`
   first (it already must, to reach the model through the Doppler sidecar); the host then pushes
   freely over that port. No page-visible surface, no TCP listener, no CDP, and `connectNative`
   keeps the MV3 service worker alive for the whole run.
5. The runner reaches that Chrome-spawned host through a **unix socket** the host binds in dev builds
   only — filesystem-permissioned and invisible to every page. Dev CLI convenience instead uses a
   **`ws://127.0.0.1` client** compiled out by `import.meta.env.COMMAND === 'serve'`; it is faster to
   build but any page can reach a loopback listener.
6. `chrome.sidePanel.open()` requires a user gesture, so the run must start in the service worker
   with the panel closed. The panel observes; it is never the trigger.
7. **Results leave over the same native port, streamed per event** — the host appends JSONL to disk
   and the test asserts on the file, mid-run if it wants. `chrome.storage.local` stays the panel's
   read model; `chrome.downloads` is a worse channel than the one already open.
8. Attaching *any* CDP client to a Chrome not launched with `--remote-debugging-port` is impossible,
   so no external driver participates (§4).
9. Determinism comes from a **replay cassette in the native host** — the same host that proxies the
   model records and replays completions — not from a second browser.
10. Claude-in-Chrome drives the browser with `chrome.debugger`. One debugger client per tab, and
    attaching raises a banner — never concurrent with our own R-13 escalation. Post-run inspector only.

## 1. Loading and reloading an unpacked extension in a running Chrome

**`--load-extension` is gone from branded Chrome.** Removed in Chrome 137
([blog](https://developer.chrome.com/blog/extension-news-june-2025),
[PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ));
`--extensions-on-chrome-urls` and `--disable-extensions-except` followed in Chrome 139
([PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/FxMU1TvxWWg/m/daZVTYNlBQAJ)).
Chromium and Chrome for Testing are unaffected; the flag "was commonly abused to load malicious and
unwanted software into the browser."

**chrome://extensions Load unpacked / Reload button.** Reload is required for manifest, service-worker
and content-script changes (content scripts also need the host page reloaded); popup/options pages do not.
https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world

**Enterprise policy is not a substitute.** `ExtensionInstallForcelist` / `ExtensionSettings` take an
`update_url` pointing at a packed CRX; an unpacked directory path is not a supported target
([policy ref](https://chromeenterprise.google/policies/extension-install-forcelist/),
[admin help](https://support.google.com/chrome/a/answer/7532015)). A running Chrome does re-read
policy without restart and Chrome 142 added `--refresh-platform-policy`
([thread](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/GJdP4Higo4M),
[community](https://www.januschka.com/chromium-omarchy.html)) — irrelevant, since policy cannot
target an unpacked path.

**Developer-mode gotcha (Chrome 134+).** Unpacked extensions auto-disable whenever the Developer Mode
toggle is off; it must stay on in the real profile.
https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cTdMVtxxooY

**`chrome.runtime.reload()`.** No permission needed, callable from the extension's own service
worker. Documented: "When an unpacked extension is reloaded, this is treated as an update… the
`chrome.runtime.onInstalled` event will fire with the `'update'` reason. This includes when the
extension is reloaded with `chrome.runtime.reload()`" — the same path the UI button takes, and what
every dev-reload tool relies on to pick up on-disk changes.
https://developer.chrome.com/docs/extensions/reference/api/runtime

**`chrome.management.setEnabled()`.** Needs the `management` permission and, per the
[docs](https://developer.chrome.com/docs/extensions/reference/api/management), "in most cases this
function must be called in the context of a user gesture," possibly with a native confirmation
dialog. Self-targeting is undocumented (a separate `uninstallSelf()` exists, implying `setEnabled` is
for *other* extensions), and a disabled extension cannot re-enable itself. **Not click-free.**

**`chrome.developerPrivate`.** The private API behind the chrome://extensions UI (`loadUnpacked`,
`reload`, …). Its feature config restricts it to the `chrome://extensions/*` WebUI context or to an
allowlist of ~7 Google-internal `platform_app` IDs. **Not available to us.** See
[`_api_features.json`](https://chromium.googlesource.com/chromium/src/+/master/chrome/common/extensions/api/_api_features.json)
and [`_permission_features.json`](https://chromium.googlesource.com/chromium/src/+/master/chrome/common/extensions/api/_permission_features.json).

**WXT dev-mode auto-reload — verified in source.** The generated
[background entrypoint](https://raw.githubusercontent.com/wxt-dev/wxt/main/packages/wxt/src/virtual/background-entrypoint.ts),
guarded by `import.meta.env.COMMAND === 'serve'`, calls
[`getDevServerWebSocket()`](https://raw.githubusercontent.com/wxt-dev/wxt/main/packages/wxt/src/utils/internal/dev-server-websocket.ts)
and registers `ws.addWxtEventListener('wxt:reload-extension', () => browser.runtime.reload())`, plus
`'wxt:reload-content-script'` (re-injects into affected tabs) and `'wxt:reload-page'`. On MV3 it also
calls `keepServiceWorkerAlive()` and registers `browser.commands.onCommand` for the same reload;
`core/utils/manifest.ts` injects that command with `suggested_key.default = wxt.config.dev.reloadCommand`.

By default `wxt dev` launches its own browser through `web-ext` with a throwaway profile.
`webExt.disabled: true` stops that — the docs give exactly our reason: "if you don't want to
uninstall web-ext, [and] like to test in your normal profile." `chromiumProfile` /
`keepProfileChanges` / `chromiumArgs` only apply to a WXT-launched browser, so they are moot here; a
maintainer confirmed WXT cannot attach to a running Chrome ("web-ext doesn't support that"). Because
the WS client is baked into the built extension, it still connects after a manual "Load unpacked"
into the real profile, so reloads stay click-free. *(Implied by the source; not an explicit
guarantee.)* [startup docs](https://wxt.dev/guide/essentials/config/browser-startup) ·
[#1314](https://github.com/wxt-dev/wxt/discussions/1314)

**`web-ext run --target chromium`.** Its
[Chromium runner](https://github.com/mozilla/web-ext/blob/09661eee/src/extension-runners/chromium.js)
uses `chrome-launcher` to **launch** a new process and the
[command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
has no attach flag; on branded Chrome 137+ it opens a blank window with no extension loaded, and the
workaround is two manual Load-unpacked clicks
([web-ext#3443](https://github.com/mozilla/web-ext/issues/3443)).

| Mechanism | Works on running normal-profile Chrome | Human click |
|---|---|---|
| Load unpacked / Reload button | yes | **yes, unavoidable** |
| `chrome.runtime.reload()` | yes (from inside the extension) | no |
| `chrome.management.setEnabled` | unverified for self; gesture required | likely |
| `developerPrivate` / enterprise policy | WebUI-or-allowlist only / no unpacked paths | n/a |
| `wxt dev` + `webExt.disabled` | yes, for reload | one-time only |
| `web-ext run --target chromium` | no (launches its own) | yes |

## 2. Triggering a run from outside the browser, without CDP

**(a) Native messaging host — recommended for the live tier.** The extension must connect first
(`runtime.connectNative`), but once the port exists the protocol is symmetric: "The same format is
used to send messages in both directions." Chrome "starts native messaging host process and keeps it
running until the port is destroyed," so the host can push a `start-task` message at any time.
Caps: host→extension **1 MB** per message, extension→host **64 MiB**. `allowed_origins` cannot
contain wildcards. Linux user manifest: `~/.config/google-chrome/NativeMessagingHosts/<name>.json`.
`connectNative()` also keeps the MV3 service worker alive (Chrome 105+).
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

The predecessor already ships this shape: `com.moosegoose.nanoreborn` →
`/home/coldaine/projects/nanobrowser/apps/sidecar/run-host.sh`, a Doppler-wrapped Node host proxying
OpenRouter so the extension never holds the key (R-12 / C-06).

Two wrinkles. **Chrome spawns the host, the runner does not** — so the runner needs a side door into
a process it did not start. Have the host `bind()` a unix socket at
`$XDG_RUNTIME_DIR/nanobrowser-test.sock` (0600, unlinked on exit) and relay between it and the stdio
port: filesystem-permissioned, not in the network namespace, invisible to `ss -ltn` and to every page
in the browser. A FIFO pair works too but gives no framing and no readiness signal. **Bind it in dev
builds only** — it is a control channel into the agent. Second, **one host process per connecting
context**: have only the service worker `connectNative`, with the side panel talking to the SW via
`runtime.sendMessage`, or a second host process races for the same socket path.

**(b) Dev-only localhost WebSocket — recommended for the CLI convenience.**
[Official pattern](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets); since
Chrome 116 "sending or receiving messages across a `WebSocket` in an extension service worker resets
the service worker's idle timer" (heartbeat ~20 s recommended). Simplest path to `pnpm task "…"` with
streaming output, reusing machinery WXT already runs in dev. Cost: a loopback listener **any page in
the browser can also connect to** — a site could probe it, a malicious one could drive the agent.
Require a per-run token from a 0600 file and reject any connection whose `Origin` is not the
extension. Fine as a dev convenience; not for the stealth-critical run.

**(c) `externally_connectable` + a localhost page.** Legal:
[match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) support
`http://localhost/*`, which "matches any localhost port," and the current Chromium parser for
[`externally_connectable.matches`](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)
accepts any valid pattern — no effective-TLD check remains in `ExternallyConnectableInfo::FromValue`
([source](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/manifest_handlers/externally_connectable.cc)).
But it needs a visible localhost tab and a manifest key in the build. Third choice.

**(d) `chrome.commands` + synthetic keystrokes.** "By default, commands are scoped to the Chrome
browser… when the browser does not have focus, command shortcuts are inactive"; `global: true`
(Chrome 35+) works unfocused but only for `Ctrl+Shift+[0..9]`
([docs](https://developer.chrome.com/docs/extensions/reference/api/commands)). This session is
Wayland: `xdotool` is X11-only, neither it nor `ydotool` is installed, and `wtype` reaches only
native Wayland clients. Keep it as a manual fallback for *reload* (WXT already registers
`wxt:reload-extension`), not as the run trigger.

**(e) Driving the side panel via Claude-in-Chrome.** Highest interference risk (§5) and makes the
test depend on a second model. Reject. Note also that `chrome.sidePanel.open()` (Chrome 116+) "may
only be called in response to a user action"
([docs](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)), so no UI-driven
trigger opens the panel for you; the run must start in the service worker with the panel closed.

| Option | Stealth | Reliability | Simplicity |
|---|---|---|---|
| (a) native host push | best — no listener, no page surface | high | medium |
| (b) dev WS | good, but a local listener exists | high | best |
| (c) externally_connectable | needs a visible tab | medium | medium |
| (d) commands + input | good | low on Wayland | low |
| (e) Claude-in-Chrome | poor — debugger banner | low | low |

**(a)** for the live acceptance run, **(b)** for `pnpm task "…"` during development.

## 3. Getting the run log out

In-extension source of truth: `chrome.storage.local` (10 MB, 5 MB pre-Chrome 113; `unlimitedStorage`
raises it), or IndexedDB once logs carry screenshots. `storage.session` is in-memory, 10 MB, defaults
to `TRUSTED_CONTEXTS`. https://developer.chrome.com/docs/extensions/reference/api/storage

**Recommended: stream, don't dump.** Post each log event over the same native port as it happens;
the host appends one JSON object per line to `runs/<runId>.jsonl`. Streaming beats an end-of-run
export for three reasons: a run that hangs or is killed still leaves a partial log, which is exactly
the log you want; the SW can be torn down mid-run, so storage plus the wire gives two independent
copies; and the runner can assert mid-run instead of waiting out `maxSteps`. Keep
`chrome.storage.local` as the panel's read model and crash recovery, but do **not** make the test
read it — that needs a second channel into the browser just to call `storage.get`, the problem
already solved. One channel, both directions.

Reject `chrome.downloads`: `URL.createObjectURL` is unavailable in a service worker
([crbug 40876652](https://issues.chromium.org/issues/40876652)), so a blob download needs an
[offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen);
[filenames](https://developer.chrome.com/docs/extensions/reference/api/downloads) must be relative to
the Downloads dir; and it produces visible UI in a directory the user actually uses.

**Redact on the way out, in the extension** — not in the host, not in the assertions: strip provider
key shapes and any `input[type=password]` value before the event is posted, so a secret never reaches
disk even if the run misbehaves (R-12).

## 4. External drivers (Playwright, CDP) — out of scope

Connecting any CDP client, Playwright included, to a Chrome not launched with
`--remote-debugging-port` (or an inherited `--remote-debugging-pipe`) is impossible — and since
Chrome 136 those switches are ignored on the default data directory anyway
([announcement](https://developer.chrome.com/blog/remote-debugging-port)).

## 5. Claude-in-Chrome

Read directly from disk (`~/.config/google-chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.90_0/manifest.json`,
v1.0.90): MV3, `host_permissions: ["<all_urls>"]`, permissions include **`debugger`**,
`nativeMessaging`, `scripting`, `tabs`, `offscreen`, `downloads`, `sidePanel`; content scripts inject
`accessibility-tree.js` at `document_start` on `<all_urls>` and `agent-visual-indicator.js` at
`document_idle`; `externally_connectable` limited to `claude.ai`; command `toggle-side-panel` (Ctrl+E).
Its bundle references `debugger.attach`, `debugger.sendCommand`, `Input.dispatchMouseEvent`,
`Input.dispatchKeyEvent`, `Input.insertText`, `Runtime.evaluate`, `Page.captureScreenshot`. Native
host: `com.anthropic.claude_code_browser_extension`. So it drives the browser with `chrome.debugger`
(CDP); Anthropic's docs describe only the per-site permission layer
([docs](https://code.claude.com/docs/en/chrome),
[permissions](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide),
[store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn)), and the
banner report was closed "not planned"
([#69287](https://github.com/anthropics/claude-code/issues/69287)).

**Interference.** Chromium rejects a second attach with
`kAlreadyAttachedError` = `"Another debugger is already attached to the * with id: *."` and creates a
warning infobar (`ExtensionDevToolsInfoBarDelegate`) on attach
([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc));
attaching to an extension background page needs `--silent-debugger-extension-api`
([docs](https://developer.chrome.com/docs/extensions/reference/api/debugger)). Claude-vs-Claude
contention is already reported (sessions competing for one browser
[#39637](https://github.com/anthropics/claude-code/issues/39637); Claude Code vs desktop app
competing for the native host [#20943](https://github.com/anthropics/claude-code/issues/20943)).
No published report of it against a *third-party* automation extension — but its `<all_urls>`
`document_start` content script and its `chrome.debugger` use both overlap ours, and it will read our
extension's own DOM mutations as page state. Run it only after `done`.

## 6. hyperagent.com

Hyperagent is an AI-agents platform publicly associated with Airtable's founder Howie Liu
([announcement](https://x.com/howietl/status/2024618178912145592)) — distinct from the unrelated
open-source `hyperbrowserai/HyperAgent`. Its [docs](https://www.hyperagent.com/docs/concepts/threads)
define a **Thread** as "one piece of work kept together: the conversation, the agent's workspace, and
everything it produced," started by an **invocation** ("a schedule firing at 7 AM, a Slack mention,
an inbound email"). The UI has a sidebar thread list with starring, a live status pill, a model chip
that "displays the model and live usage," a usage meter in thread settings, a Command Center, a
Library of artifacts, and [Settings → Billing](https://www.hyperagent.com/docs/billing/plans) with
plan and credit balance.

**Use (1) as the acceptance task**, (2) and (3) as variants: (1) open the thread list and report the
titles and statuses of the three most recent threads; (2) open the most recent thread and report the
model chip's model and usage figure; (3) open Settings → Billing and report plan and remaining
balance. All three are navigation plus reading — no composer input, no fork, no star, no invocation.
Assert on structure (three items, non-empty titles, a numeric usage value), never on values.

## Recommendation

### One-time setup (human, once)

`wxt dev` with `webExt.disabled: true`, then "Load unpacked" `.output/chrome-mv3` into the real
profile with Developer mode on. Register the host manifest at
`~/.config/google-chrome/NativeMessagingHosts/com.moosegoose.nanobrowser.json` with
`allowed_origins: ["chrome-extension://<id>/"]` (no wildcards). Set a manifest
[`key`](https://developer.chrome.com/docs/extensions/reference/manifest/key) so the ID stops being
derived from the load path and the registration survives rebuilds. The rest is scripted.

### Per-run sequence

1. **Build + reload.** The runner writes source, then sends the WXT dev-server `wxt:reload-extension`
   event; the injected client calls `browser.runtime.reload()`. No click (fallback: the
   `wxt:reload-extension` keyboard command). Do not sleep — reload tears down the service worker and
   the native port with it, so wait on the barrier in step 3.
2. **Host comes up.** The SW calls `runtime.connectNative('com.moosegoose.nanobrowser')` at every
   startup (`onInstalled` + `onStartup` + top level), so the port exists within a second of reload
   and keeps the SW alive for the whole run.
3. **Runner connects to the host, not to Chrome.** The host (the Doppler sidecar, extended) listens
   on `$XDG_RUNTIME_DIR/nanobrowser-test.sock`. The runner connects and waits for
   `{"op":"ready","extensionVersion":…}`, emitted when the native port opens — that is the barrier.
4. **Start.** Runner writes
   `{"op":"start","runId":…,"task":…,"leaderModel":…,"followerModel":…,"navMode":"dom","allowEscalation":false}`;
   the host forwards it over the native port. The SW starts the Leader/Follower loop **with the side
   panel closed** — required, since `sidePanel.open()` needs a gesture. An open panel subscribes to
   the same event stream and renders it (R-05/R-07) but is never on the critical path.
5. **Stream.** Every event — leader plan, follower step, tool call, each
   `CONTINUE | SUBGOAL_COMPLETE | RETURN_TO_LEADER | BLOCKED` signal, each control transfer — goes to
   `chrome.storage.local` (UI + crash recovery) *and* over the native port. The host appends
   `runs/<runId>.jsonl` and mirrors to the socket so the runner can fail fast. Terminal event:
   `{"op":"done","status":…,"answer":…}`.
6. **Assert** on the JSONL: terminal status reached; ≥1 Leader→Follower and ≥1 Follower→Leader
   transfer logged (R-03) with re-planning matching `planningInterval` (R-04); `maxSteps` not hit;
   three thread entries with non-empty titles; no `chrome.debugger` attach (R-02); no secret-shaped
   string anywhere (R-12).
7. **Independent inspection, strictly after `done`** — only then invoke Claude-in-Chrome to read the
   page and compare against the answer. Never concurrently (§5).

### Determinism without a second browser

Put the cassette in the host, where the model calls already flow. `{"record":"<name>"}` writes each
completion to `cassettes/<name>.jsonl`; `{"replay":"<name>"}` serves them back in order and fails
loudly on an unexpected prompt hash. Same extension, same real Chrome, same real page — only the
model is pinned: a fast repeatable regression run, plus a nightly live-model run for honest signal.

### The dev-only hook, and compiling it out

One module, `entrypoints/background/testHook.ts`, imported behind
`if (import.meta.env.COMMAND === 'serve')` — WXT's own convention, verified in its background
entrypoint above — so Rollup tree-shakes it out of `wxt build`. It owns exactly three things: the
native-host `start`/`abort` handlers, the log streamer, and the dev `ws://127.0.0.1` client. The
production loop imports none of them; the SW's own `connectNative` for model calls stays, being a
product feature rather than a test hook.

WXT's manifest may be a function — `manifest: ({ browser, manifestVersion, mode, command }) => …` —
so any `externally_connectable` key and extra `commands` are emitted only when `command === 'serve'`.
Gate it in CI: after `wxt build`, fail if `.output/chrome-mv3` contains `127.0.0.1`, `testHook`,
`externally_connectable`, or the `op":"start` literal. That grep is the guarantee, not the guard.

## Unattended testing (as built)

The research above assumed the WXT dev server's `wxt:reload-extension` event. The shipped
loop does not need it: the host already has a native port to the service worker, so the
reload rides that instead — one fewer moving part, and it works against a plain
`pnpm build` artifact loaded unpacked, with no dev server running at all.

**One manual step, once ever.** Load `.output/chrome-mv3` unpacked at
`chrome://extensions` with Developer mode on, and run `host/install.sh --dev`. Both survive
every rebuild, because `chrome.runtime.reload()` re-reads an unpacked extension from disk
and the manifest `key` pins the ID (`dnicmmdhogcepeiooangkhhmdgphmonb`).

**Then, forever:**

```
scripts/e2e.sh
```

which is:

1. `pnpm build`
2. `host/bin/nb-reload` — socket op `reload` → host pushes `ext.reload` → the worker calls
   `chrome.runtime.reload()`. That kills the service worker, the native port, and the host
   itself, so "it answered" is not success. nb-reload polls `status` until the host **pid
   has changed** *and* `extensionConnected` is true again (30 s default). Exit 2 means no
   extension is connected at all — the one case that needs a human.
3. `host/bin/nb-status` — validated key readiness (R-11), not assumed.
4. `host/bin/nb-run "<prompt>" --url … --option leaderModel=… --option followerModel=…
   --option observe=… --option inputFidelity=…`, streaming the run log to
   `runs/e2e-<timestamp>.jsonl` (gitignored).
5. Assert the final `run.ended.status` is `done`, print the `done` tool's summary, then
   print every `ext.log` error stamped inside the run window
   (`host/bin/nb-logs --since <iso> --level error`). A run that "passed" while the worker
   was throwing exits non-zero: the whole point of forwarding those is that they stop being
   invisible.

Defaults are the read-only Hyperagent threads task on `https://hyperagent.com` with
`nvidia/nemotron-3-ultra-550b-a55b:free` leading and `nvidia/nemotron-3.5-lightning:free`
following, `observe=dom`, `inputFidelity=in-page`. Every one is overridable by flag or
`NB_E2E_*` environment variable; `--skip-build` reuses the current `.output/chrome-mv3`.

**The one thing a human still has to get right:** the worker navigates the active tab of
the last focused normal window to `--url` before the run starts, and it refuses to script a
`chrome://` page. Leave a normal web page focused. If that tab is `chrome://extensions`
(easy to do right after loading the extension) the script prints the refusal verbatim and
says what to do about it, rather than reporting a generic error.

**Where the errors go.** `self.addEventListener('error')`, `unhandledrejection`, and
wrapped `console.error`/`console.warn` in the worker; the same on `window` in the panel,
relayed over the existing panel→worker port. Everything lands in
`~/.local/share/nanobrowser/ext.log` as JSON lines, with errors mirrored into `host.log`.
The original console call always still happens, so the DevTools view a human opens is
unchanged. Both sides redact `sk-or-` shapes (R-12).

## Risks

- **One tier, no safety net.** Every regression is now caught by a run against a live third-party
  site. Cassette mode is what keeps that tolerable — build it with the harness, not after it.
- **The one manual click.** If the extension is ever removed, the tier needs a human before it runs
  again. Document it; do not automate around it. Pinning the ID with `key` limits how often.
- **Model nondeterminism.** Assert on structure and control-flow events, never on model prose.
  A single live failure is a signal, not a verdict.
- **Debugger banner.** Any R-13 escalation during a live run raises Chrome's infobar and breaks R-02
  for that run. Keep escalation off here; test it in a dedicated case that owns the cost.
- **Two automation extensions.** Claude-in-Chrome holds `<all_urls>` + `debugger`; serialize the
  phases and assert our run reached `done` before invoking it. Wayland also kills any xdotool plan.
- **Service-worker suspension.** Keep the native port open for the whole run; without traffic the SW
  dies at 30 s and takes the run with it. Host→extension messages cap at 1 MB — chunk large payloads.
- **The dev socket is a control channel into the agent.** Anything that can write it drives the
  browser as the user. 0600, dev builds only, and the CI grep is what enforces that.
- **Hyperagent is a live third-party product.** Its UI can change without notice, and a "read-only"
  task can still spend credits if the agent misclicks. Pin the task to navigation + reading, and give
  the Follower no submit-capable tools for this run.
- **Chrome keeps tightening.** 136 (remote debugging), 137 (`--load-extension`), 139
  (`--disable-extensions-except`), 142 (workarounds). Re-verify this document each major release.
