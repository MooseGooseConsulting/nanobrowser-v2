# Secrets → model calls: native-messaging host research

Researched 2026-09-03. All web claims verified live (not training memory) via Chrome docs,
Doppler docs, npm registry, GitHub source, and OpenRouter live endpoints; discrepancies
from commonly-cited numbers are flagged explicitly below.

## Answer-first summary

1. Host manifest lives at `~/.config/google-chrome/NativeMessagingHosts/<name>.json` and
   the Chromium equivalent — both dirs already exist on this machine with real hosts.
2. **The "4 GB extension→host" limit is wrong/stale.** Current Chrome docs say **64 MiB**
   extension→host, **1 MB** host→extension. Design around 64 MiB, not 4 GB.
3. A stable dev extension ID comes from an openssl-derived RSA public key in
   manifest `key`; WXT has no built-in stable-ID feature — you paste it in yourself.
4. Native messaging has no streaming primitive, but chunked JSON messages over an
   open `connectNative` port work as pseudo-streaming; both prior local attempts
   avoided this by turning streaming off entirely — real evidence it's nontrivial.
5. Recommended design is a **hybrid**: native messaging as a control plane (bootstrap
   a per-session localhost proxy port + bearer token), localhost HTTP proxy as the
   data plane for actual model calls (real SSE streaming, no 64 MiB ceiling).
6. `doppler secrets get NAME --plain -p PROJECT -c CONFIG` is the correct, current
   single-secret read; the local CLI here is already logged in with a personal
   token (`dp.ct.*`), confirmed via `doppler configure`.
7. `@dopplerhq/node-sdk` is stale (last published 2024-04-08) — shell out to the
   `doppler` CLI instead, reusing the user's existing login.
8. `ai-automation`/`dev` has `OPENROUTER_API_KEY`, `OPENAI_API_KEY` (+variants),
   `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`,
   `NVIDIA_NIM_API_KEY`(+`_2`), `XAI_GROK_API_KEY`, and more — **no `ANTHROPIC_API_KEY`
   exists today**.
9. `GET https://openrouter.ai/api/v1/key` validates a key without spending a
   completion; `GET /api/v1/models` works fully unauthenticated (confirmed live).
10. `ChatOpenAI({ configuration: { baseURL, fetch } })` is real and currently
    supported, confirmed from `@langchain/openai` source — this is what makes the
    hybrid design pointable from LangChain with no custom transport code.

---

## 1. Native messaging on Linux (Chrome & Chromium)

Canonical current doc (the old Chrome-Apps URL is deprecated):
https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

- **Manifest location**, quoted from the doc: Chrome
  `~/.config/google-chrome/NativeMessagingHosts/com.my_company.my_application.json`,
  Chromium `~/.config/chromium/NativeMessagingHosts/...`. System-wide variants exist at
  `/etc/opt/chrome/native-messaging-hosts/...` and `/etc/chromium/native-messaging-hosts/...`.
  Confirmed locally — both user dirs exist with real manifests (`com.anthropic.claude_code_browser_extension.json`,
  `com.openai.codexextension.json`, `com.omarchy.*`, and the prior attempt's own
  `com.moosegoose.nanoreborn.json`).
- **Manifest fields** (exactly 5, all required, no undocumented optional fields):
  `name` (lowercase alphanumeric/underscore/dot, no leading/trailing dot), `description`,
  `path` (must be absolute on Linux), `type` (only legal value `"stdio"`),
  `allowed_origins` (array of `chrome-extension://<id>/`, no wildcards).
- **Stable extension ID**: Chrome's own `key` doc
  (https://developer.chrome.com/docs/extensions/reference/manifest/key) doesn't give the
  derivation steps; cross-verified openssl recipe (two independent community sources,
  algorithm sanity-checks against known Chrome behavior):
  ```
  openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
  openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A     # → manifest "key"
  openssl rsa -in key.pem -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p   # → extension id
  ```
  **WXT has no dedicated stable-ID feature.** Its `manifest` config option can be a
  function of `{ browser }` (https://wxt.dev/guide/essentials/config/manifest,
  confirmed by fetch — no mention of `key`/stable-id anywhere on that page), so you set
  `manifest: ({ browser }) => ({ key: 'PUBLIC_KEY_HERE' })` yourself
  (https://github.com/wxt-dev/wxt/discussions/505).
- **Message framing**: 4-byte little-endian length prefix + UTF-8 JSON body, both
  directions. **Max sizes, quoted directly from the live doc**: "The maximum size of a
  single message from the native messaging host is 1 MB... The maximum size of the
  message sent to the native messaging host is 64 MiB." The commonly-cited "4 GB"
  extension→host figure is **not what the current doc says** — treat 64 MiB as current
  truth for design purposes.
- **`connectNative` lifecycle**: "Chrome starts native messaging host process and keeps
  it running until the port is destroyed" (one process per port); `sendNativeMessage`
  spawns a new process per call. Per the Service Worker Lifecycle doc
  (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle):
  "Chrome 105 — Connecting to a native messaging host using `connectNative()` will keep a
  service worker alive. If the host process crashes or is shut down, the port is closed
  and the service worker will terminate after timers complete." Two Chromium-tracker
  caveats worth designing around: SW going inactive despite an open port when combined
  with `onConnectExternal`/`connect()` (github.com/GoogleChrome/developer.chrome.com/issues/2688),
  and disabling an MV3 extension not reliably closing the host's IO, risking a duplicate
  host on re-enable (github.com/GoogleChrome/developer.chrome.com/issues/559). Don't
  assume clean disconnect semantics; the host should self-timeout.
- **stdio/stderr**: quoted — "Make sure that all output in stdout adheres to the native
  messaging protocol. If you want to print some data for debugging purposes, write to
  stderr." Chrome logs native-messaging failures (fail to start, stderr writes, protocol
  violations) to its own error log, visible on Linux by launching Chrome from a terminal.
- **Shell wrapper / node version manager gotcha**: `path` must be absolute but can be a
  shell script. `#!/usr/bin/env node /abs/script.mjs` breaks because the Linux kernel's
  shebang handling passes everything after the interpreter name as **one** argument to
  `env` (https://blog.winny.tech/posts/multiple-arguments-in-shebang/); use
  `#!/bin/sh` + `exec node /abs/script.mjs "$@"` instead. Separately: Chrome is launched
  by the desktop environment, not an interactive login shell, so it never sees mise/nvm's
  shell-rc PATH injection — `env: node: No such file or directory` is a well-known class
  of failure (nvm issues #1702, #2458, #2809; a native-messaging-specific example fixes
  this by hardcoding an absolute node path — github.com/deathcap/nodeachrome README).
  **Locally confirmed**: `/home/coldaine/.local/share/mise/installs/node/26.7.0/bin/node`
  exists, is executable, and runs a `.ts` file directly via built-in type-stripping with
  no build step (`node --help` shows `--experimental-strip-types, --no-strip-types`,
  and a trivial `.ts` file executed correctly unflagged) — good news for a zero-build
  host script, but the manifest/wrapper must hardcode this absolute path.

## 2. Design A (native-messaging proxy) vs Design B (localhost HTTP proxy)

**A — full request/response over native messaging.** No streaming primitive exists, but
nothing stops emitting N chunked JSON messages tagged with a request id + sequence
number over one open `connectNative` port — genuine pseudo-streaming, just hand-rolled.
Both prior local attempts (`nanobrowser/apps/sidecar/src/host.mjs`,
`nanobrowserkimitry/apps/harness/src/host/main.ts`) instead forced `stream:false` /
did one buffered fetch — real evidence this is more work than it looks and both spikes
punted on it. The 64 MiB extension→host cap comfortably covers multiple base64 JPEGs
(100–500 KB each) in a request; the 1 MB host→extension cap only bites if the host ever
needs to push something large back unchunked. Security win: only the extension (gated by
`allowed_origins` + the stable extension ID) can ever reach this host — no other local
process can open the port.

**B — localhost HTTP proxy.** Real HTTP means real SSE/chunked streaming with no library
gymnastics, and no 1 MB/64 MiB ceiling at all. The real cost is that **any local
process** can hit `127.0.0.1:<port>` — the built-in `allowed_origins` gate Design A gets
for free doesn't exist here. Mitigation (effectively turns this into the hybrid):
bind `127.0.0.1` only, pick a random port per host-process lifetime, mint a per-session
bearer token, and hand `{port, token}` to the extension *only* over the still-gated
native-messaging channel — a local process without that token can connect the socket
but can't authenticate. SW lifetime is less explicit here: a page `fetch()` to localhost
follows ordinary MV3 SW in-flight-request rules, not the Chrome-105 `connectNative`
guarantee, so a long SSE stream is not documented to pin the SW the same way.

**Pointing LangChain at either.** Confirmed directly from
`github.com/langchain-ai/langchainjs`, `libs/providers/langchain-openai/src/chat_models/base.ts`
(current `main`, `@langchain/openai@1.5.11` per npm registry, 2026-09-01): the
constructor spreads `fields.configuration` into `clientConfig`, which becomes the
`openai` SDK's `ClientOptions` (`baseURL`, `fetch`, `defaultHeaders`, `apiKey` — all
confirmed present in `openai@7.10.0`'s `ClientOptions`). So
`new ChatOpenAI({ configuration: { baseURL: 'http://127.0.0.1:<port>/v1', fetch: withBearer } })`
is real and current. This is trivial for Design B (an HTTP `baseURL` is exactly what
`ClientOptions` wants) and awkward for pure Design A (you'd have to write a `fetch`-shaped
function that internally speaks native messaging and fabricates a `Response`/`ReadableStream`
— possible, but strictly more code than pointing `baseURL` at a real server).

## 3. Doppler

- `doppler --version` (local): `v3.76.5`. `doppler configure` (local) shows a
  `dp.ct.*`-prefixed **personal/CLI token** already logged in — not a service token.
- Reading one secret non-interactively: `doppler secrets get NAME --plain -p PROJECT -c CONFIG`
  (https://docs.doppler.com/docs/accessing-secrets — `--plain` is the documented flag for
  direct single-value retrieval).
- Service token (`dp.st.*`, e.g. `dp.st.dev.bAqh...`) vs personal/CLI token (`dp.ct.*`):
  per https://docs.doppler.com/reference/auth-token-formats and
  https://docs.doppler.com/docs/service-tokens — service tokens are "read-only... to a
  specific config," meant for non-interactive/production use, set via
  `DOPPLER_TOKEN` env var or `doppler configure set token`; the docs explicitly warn
  "Don't use a CLI or Personal Token in live environments... same permissions as the
  account." For a **local dev host**, subprocessing the already-logged-in CLI is simplest
  and needs no extra credential provisioning.
- `@dopplerhq/node-sdk`: latest npm version **1.3.0, published 2024-04-08**, nothing
  since (https://registry.npmjs.org/@dopplerhq/node-sdk) — stale relative to the CLI.
  It talks to Doppler's HTTP API directly and requires its own `accessToken` (a service
  token) — an extra credential to manage vs. reusing the CLI's existing session.
  **Recommendation: shell out to the CLI, not the SDK.**
- Secret names in `ai-automation`/`dev` that look like LLM keys (confirmed live via
  `doppler secrets --only-names -p ai-automation -c dev`): `OPENROUTER_API_KEY`,
  `OPEN_ROUTER_MANAGEMENT_KEY`, `OPENAI_API_KEY` (+`_2`,`_3`,`_PRIMARY`,
  `_MANAGEMENT_KEY`,`_COMFYUI_CHATGPT`,`_COMFYUI_COPILOT`,`_KEY_LIMITED_FREE_USAGE`,
  `_TEST_SPRITE`), `GEMINI_API_KEY`(+`_REFRESH`), `DEEPSEEK_API_KEY`, `GROQ_API_KEY`,
  `MISTRAL_API_KEY`, `CEREBRAS_API_KEY`(+`_PAID_KEY`), `NVIDIA_NIM_API_KEY`(+`_2`),
  `XAI_GROK_API_KEY`, `MOONSHOT_AI_API_KEY`, `Z_AI_API_KEY`(+`_BACKUP`),
  `MINIMAX_API_KEY`, `PERPLEXITY_API_KEY`, `VLLM_API_KEY`, `VERDA_INFERENCE_KEY`.
  **No `ANTHROPIC_API_KEY` exists in this config** — add it before wiring Anthropic support.
- Host caching: keep the fetched value only in a process-local variable, never written to
  disk/log; fetch fresh on each host-process start (which is once per
  `connectNative` port/session anyway, so rotation just means restarting the session).

## 4. Readiness (R-11)

- `GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>` validates the
  key and returns limits without spending a completion — confirmed live (unauthenticated
  or bad-token requests return `401 {"error":{"message":"No cookie auth credentials
  found","code":401}}`). Doc: https://openrouter.ai/docs/api-reference/limits. Response
  shape per that page: `data: { label, limit, limit_reset, limit_remaining, usage,
  usage_daily/weekly/monthly, is_free_tier, ... }` — note there is **no** `rate_limit`
  object on the current page despite that being commonly assumed; don't rely on it.
  (The older `/api/v1/auth/key` path behaves the same in a live 401 test but is not on
  current docs — treat `/api/v1/key` as canonical.)
- `GET https://openrouter.ai/api/v1/models` returned live `200` with **no** Authorization
  header at all — it's a public catalog/pricing listing, not account-gated. A
  per-account filtered variant lives at `/api/v1/models/user` if the panel wants
  "models this key can actually use."
- Host reports `{provider, ready: boolean, reason?}` to the panel per configured
  provider, and separately serves `/models` so the panel can populate its dropdown —
  the host never picks a model itself (C-07); it only says which providers are usable.
- Other providers (OpenAI `GET /v1/models` with Bearer, etc.) follow the same
  cheap-authenticated-GET pattern but weren't independently verified this pass — confirm
  per-provider before shipping.

## 5. Alternatives to native messaging (still satisfying R-12)

None exist *inside* the extension — any in-extension storage (`chrome.storage`,
IndexedDB) is precisely what R-12/C-06 forbid, encrypted or not, since the extension
process itself is the untrusted boundary. Outside the extension, C-06 already names the
future backends: **OS keychain** via `secret-tool` (libsecret / freedesktop Secret
Service API — a host could shell `secret-tool lookup ...` exactly like it shells
`doppler secrets get`) and **OpenBao** (Vault fork, HTTP API or `bao read` with a locally
stored token, analogous to a Doppler service token). Neither was independently verified
live this pass (out of scope for this research cycle) — flagged as future work. The
actionable point: keep one narrow `getSecret(name): Promise<string|null>` function inside
the host so swapping backends later never touches the native-messaging protocol or the
extension, per C-06's own "replace it if something better satisfies R-12."

## 6. Prior hosts — what to copy, what was wrong

**`nanobrowser/apps/sidecar/src/host.mjs` + `install.mjs`** — worth copying: correct
4-byte-LE framing with a proper partial-read loop; URL allowlist on outbound fetch
(only `https://openrouter.ai`); strips any client-supplied `Authorization` header before
setting the real one; config via `c12` + `zod`; `install.mjs` writes the manifest to
*both* Chrome and Chromium dirs and `chmod 0o755`s the host script. Wrong: forces
`stream:false` on every request (no streaming at all — direct evidence for §2's
concern); the readMessage size guard rejects messages `> 1024*1024` on the *inbound*
(extension→host) side, which is backwards relative to the real 64 MiB extension→host /
1 MB host→extension split; `extensionId` is hardcoded independently in both
`sidecar.config.json` and `install.mjs` with no single source of truth, so they can
drift; `run-host.sh` wraps `doppler run` (injects the *entire* ~100-secret dev config
into the process env) rather than fetching just the one secret needed; no readiness/
validation-only check; no fetch timeout.

**`nanobrowserkimitry/apps/harness/src/host/main.ts`** — worth copying: clear
protocol-shape comment block at the top; explicit "completions cross the bridge, keys
never do" design comment; `node main.ts` run directly via Node's type-stripping (no
build step, confirmed locally as viable on Node 26.7.0); `trySpawn` helper that never
throws and never logs the key, with a sensible two-tier lookup (`doppler secrets get`
then fall back to `doppler run -- printenv`); `AbortSignal.timeout(110_000)` on the
outbound fetch; structured `{ok:false,error}` on every failure path; a cleaner
single-buffer `readFrames` (grows one `Buffer`, slices off complete frames) vs. the
sidecar's nested-promise read loop. Wrong / incomplete: **`manifest.json` is 0 bytes** —
confirmed by direct read — this attempt was never actually registered with Chrome at
all; **`install.ts`, referenced by `package.json`'s `install-host` script, does not exist
on disk** (confirmed via `find`) — the documented install path is vaporware; no
`extensionId`/`allowed_origins` concept anywhere in `host.config.ts`; no streaming; no
readiness check separate from a full completion attempt.

Both prior attempts: single-provider (OpenRouter) only, no multi-provider abstraction,
no streaming, no dedicated readiness endpoint — exactly the gaps this project needs to
close.

## Recommendation

**Hybrid**: native messaging as the control plane, a localhost HTTP proxy as the data
plane.

1. Extension connects via `chrome.runtime.connectNative(hostName)` once per side-panel
   session. Host, on a `bootstrap` message, starts (or reuses) an HTTP server bound to
   `127.0.0.1:<random port>`, mints a per-session bearer token, and replies
   `{port, token}` — the only things that ever cross native messaging besides small
   control messages (`readiness`, `models` requests are fine over native messaging too,
   or proxied through the same HTTP server; either works since they're small).
2. The HTTP server validates `Authorization: Bearer <token>` on every request, resolves
   the requested provider's key via `doppler secrets get NAME --plain -p ai-automation -c dev`
   (subprocess, not the SDK), attaches it upstream, and streams the SSE response straight
   through — no 64 MiB/1 MB ceiling, no hand-rolled chunking.
3. LangChain points straight at it: `new ChatOpenAI({ configuration: { baseURL:
   'http://127.0.0.1:<port>/v1', fetch: addBearerToken } })`.
4. Tie the HTTP server's lifetime to the native-messaging port (`onDisconnect` stops it,
   plus its own idle self-timeout as a backstop against the Chromium-tracker disconnect
   edge cases in §1).

**Linux install steps**: generate the openssl keypair once → derive `key`/extension ID
→ set in WXT's `manifest: ({browser}) => ({ key })` → write
`~/.config/google-chrome/NativeMessagingHosts/<name>.json` and the Chromium equivalent,
`path` pointing at a `#!/bin/sh` wrapper that `exec`s the absolute mise-managed node
path against the host script, `allowed_origins: ["chrome-extension://<id>/"]`, `chmod +x`
the wrapper.

**Dev-only variant**: skip per-secret `doppler secrets get` calls and just run the host
under `doppler run --project ai-automation --config dev -- node host.ts` for speed,
same as `nanobrowser`'s `run-host.sh` — acceptable for local dev, not for anything
shared/multi-user.

**Panel's model list**: panel asks the host (over native messaging) for readiness per
configured provider (§4); for each ready provider it calls `GET /models` through the
localhost proxy (OpenRouter's is unauthenticated and public) to populate the dropdown.
The host never defaults or picks a model — it only reports what's usable, satisfying
C-07.

## Risks

- 64 MiB extension→host is the real ceiling (not 4 GB) — keep native-messaging control
  messages small; route anything size-heavy through the HTTP data plane.
- Chromium tracker bugs #2688 and #559 mean SW-keepalive-via-`connectNative` and
  host-process cleanup on extension unload are not 100% reliable — the HTTP server needs
  its own idle-timeout shutdown, not just `onDisconnect`.
- The localhost proxy is reachable by any local process/user on a shared machine; the
  random-port + per-session-token mitigation narrows but does not eliminate this —
  worth an explicit sign-off given C-06's guarantee is stronger under native-messaging-only.
- `@dopplerhq/node-sdk` is stale (last publish 2024-04-08) — don't build on it.
- No `ANTHROPIC_API_KEY` currently exists in `ai-automation`/`dev`.
- Node type-stripping needs the manifest/wrapper to hardcode an absolute node path
  (mise/nvm PATH is invisible to Chrome) — confirmed locally at
  `/home/coldaine/.local/share/mise/installs/node/26.7.0/bin/node`.
