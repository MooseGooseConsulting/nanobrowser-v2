# Host protocol

The native-messaging host **is** the daemon. One process, one channel: Chrome spawns
`host/bin/nanobrowser-host` over stdio when the extension calls `chrome.runtime.connectNative`,
and everything the host does happens on that channel. There is no listening TCP port and no
auth token, because `allowed_origins` in the host manifest already restricts who may talk to
it — only our extension ID, no wildcards.

Host name: `com.nanobrowser.host`.
Manifest: `~/.config/{google-chrome,chromium}/NativeMessagingHosts/com.nanobrowser.host.json`,
written by `host/install.sh`.

What it provides:

| Capability | Requirement |
| --- | --- |
| Doppler-backed secret, never seen by the extension | R-12, C-06 |
| LLM proxy; the extension names the model, the host never substitutes one | C-07 |
| `key.status` — validated readiness, not assumed readiness | R-11 |
| Run-log sink (`runs/<runId>.jsonl`) | R-07 |
| `save_file` artifact sink (`artifacts/<runId>/<filename>`) | O-05 |
| Dev-only unix-socket run trigger | live testing |
| Dev-only extension self-reload (`reload` op) | unattended loop |
| Extension error sink (`ext.log`) | unattended loop |
| Input-injection slot (`NullInjector` today) | R-13 |

## Framing

4-byte little-endian unsigned length prefix, then that many bytes of UTF-8 JSON. Same in both
directions. Implemented in `host/src/framing.ts`; the parser handles partial headers, partial
bodies, and several frames in one chunk.

| Direction | Max bytes per message |
| --- | --- |
| extension → host | 64 MiB (`MAX_INBOUND_BYTES`) |
| host → extension | 1 MB (`MAX_OUTBOUND_BYTES`) |

A frame declaring more than the inbound limit is a protocol violation: the host logs it and
exits. An outbound message over 1 MB throws before it is written — this is why response bodies
are chunked (below) rather than buffered.

stdout belongs to the protocol. Diagnostics go to `~/.local/share/nanobrowser/host.log` and
stderr. The API key is never logged: nothing secret-shaped is passed to the logger, and every
line is additionally run through a redactor before it is written.

## Common shapes

Every request carries a string `id`; every response to it echoes that `id`. The one exception is
`runlog.append`, where `id` is optional (fire-and-forget logging).

Errors are `{ "type": "error", "id"?, "code", "message" }` — except in-flight LLM streams, which
report `{ "type": "llm.error", "id", "code", "message" }` so a stream consumer has one terminal
event type to watch for.

`code` is one of: `bad_request`, `unknown_type`, `no_key`, `upstream`, `aborted`,
`cassette_miss`, `io`, `internal`.

## Messages

### host → extension: `hello`

Sent once, immediately after startup.

```json
{ "type": "hello", "hostVersion": "0.0.1", "dev": false, "cassette": "off" }
```

`cassette` is `off` | `record` | `replay`. `dev` reflects `NANOBROWSER_DEV=1` / `--dev`.

### `key.status` → `key.status.result`

```json
{ "type": "key.status", "id": "1" }
{ "type": "key.status.result", "id": "1", "ready": true }
{ "type": "key.status.result", "id": "1", "ready": false, "reason": "GET /key returned 401" }
```

Implemented by `GET https://openrouter.ai/api/v1/key` with the real key — it validates without
spending a completion. `ready:false` with no network call when no secret was loaded. The key
itself never appears in the response.

### `models.list` → `models.list.result`

```json
{ "type": "models.list", "id": "m1" }
{
  "type": "models.list.result", "id": "m1", "status": 200,
  "body": {
    "sources": {
      "openrouter": { "status": 200, "body": { "data": [ … ] } },
      "kilo": { "status": 200, "body": { "data": [ … ] } }
    },
    "errors": { "kilo": "upstream status 500" }
  }
}
```

Both catalogs — `GET /api/v1/models` on OpenRouter and `GET /models` on the Kilo AI Gateway
(`https://api.kilo.ai/api/gateway/models`) — are fetched **in parallel** (`LlmProxy.modelsAll`
in `host/src/llm.ts`) and merged under `body.sources`. OpenRouter's catalog is public, so **no
Authorization header is sent** for it; Kilo's is attached with the Kilo key when one is loaded
(unconfirmed whether Kilo requires it, so this is "attach if we have it", not "assume public").
A source that fails (network error, or a non-200 status) does not fail the whole call: the
surviving source's entry still appears under `sources`, and `errors` names which source failed
and why. `errors` is only present when at least one source failed; outer `status` is `200` when
at least one source succeeded, `502` only if both failed. The side panel populates its model
pickers from this, tagging each entry's `source` (`src/host/native.ts`); the host never picks or
defaults a model (C-07).

### `llm.request` → `llm.chunk`\* → `llm.end` | `llm.error`

```json
{
  "type": "llm.request",
  "id": "r1",
  "url": "/chat/completions",
  "method": "POST",
  "headers": { "X-Anything": "…" },
  "body": { "model": "nvidia/nemotron-3.5-lightning:free", "messages": [ … ], "stream": true }
}
```

- `url` is a path under `https://openrouter.ai/api/v1/` **or** `https://api.kilo.ai/api/gateway/`
  — a relative path (no scheme) defaults to OpenRouter, unchanged from before Kilo existed. An
  absolute URL is accepted only if it is on one of these two known origins; anything else is
  rejected with `bad_request` rather than silently rewritten or proxied. Which of the two
  credentials gets attached is decided **by this URL's origin alone** (`resolveUrl` in
  `host/src/llm.ts`), never by anything the client asserts about itself — a request aimed at
  Kilo's origin can never come back with the OpenRouter key attached, or vice versa.
- `method` defaults to `POST` when a `body` is present, `GET` otherwise.
- `headers` must not carry credentials. `authorization`, `host`, `content-length`, `connection`,
  `http-referer` and `x-title` are stripped from whatever the extension sends; the host then sets
  `Authorization: Bearer <key>`, `HTTP-Referer` and `X-Title` itself. A client-supplied
  `Authorization` can therefore never reach OpenRouter.
- `body` is serialized as JSON; `content-type: application/json` is added if absent.
- The model comes from the extension's `body.model` and is never substituted (C-07).

Response, streamed:

```json
{ "type": "llm.chunk", "id": "r1", "bytes": "<base64 of raw body slice>" }
{ "type": "llm.end", "id": "r1", "status": 200, "headers": { "content-type": "text/event-stream" } }
```

`bytes` is base64 of a **raw** slice of the upstream body — SSE frames are not parsed or
reassembled by the host. Slices are at most 64 KiB (`CHUNK_BYTES`) of raw bytes, so a single
message stays well under the 1 MB host→extension cap even after base64 and JSON overhead.
Concatenating every `llm.chunk` for an `id` in arrival order reconstructs the body exactly.

Failures emit `llm.error` instead of `llm.end`:

| code | when |
| --- | --- |
| `no_key` | no OpenRouter key was loaded from the secret provider |
| `bad_request` | missing/foreign `url` |
| `upstream` | fetch threw (DNS, TLS, reset) |
| `aborted` | `llm.abort` was received for this `id` |
| `cassette_miss` | replay mode and no cassette matches |

### `llm.abort`

```json
{ "type": "llm.abort", "id": "r1" }
```

Aborts the in-flight request with that `id`; the stream terminates with
`llm.error` / `aborted`. Unknown ids are a silent no-op.

### `runlog.append` → `runlog.ack`

```json
{ "type": "runlog.append", "id": "a1", "runId": "run-mgh1-9f3c", "event": { "type": "leader.plan", "step": 0 } }
{ "type": "runlog.ack", "id": "a1", "runId": "run-mgh1-9f3c", "ok": true }
```

Appends `JSON.stringify(event) + "\n"` to
`~/.local/share/nanobrowser/runs/<runId>.jsonl`.

`runId` **must** match `[A-Za-z0-9_-]{1,64}`; anything else is rejected with `bad_request` and
nothing is written. The validation runs before the string touches a path, so no `runId` can
escape the runs directory. `id` is optional; when present it is echoed on the ack.

Events are also mirrored to any dev-socket subscriber for that run. An event whose `type` is
`run.end` closes those subscribers.

Redaction is the **extension's** job, on the way out: strip provider-key shapes and
`input[type=password]` values before posting the event, so a secret never reaches disk even if a
run misbehaves (R-12).

### `artifact.save` → `artifact.save.result`

The Follower tool `save_file`'s native-messaging half (the other half is
`chrome.downloads.download` straight to the user's Downloads/nanobrowser folder — see
`src/agent/tools.ts` and `src/runtime/pageTools.ts`).

```json
{ "type": "artifact.save", "id": "f1", "runId": "run-mgh1-9f3c", "filename": "ddr5-sold.json", "content": "…" }
{ "type": "artifact.save.result", "id": "f1", "runId": "run-mgh1-9f3c", "filename": "ddr5-sold.json", "bytes": 4821,
  "path": "/home/user/.local/share/nanobrowser/artifacts/run-mgh1-9f3c/ddr5-sold.json" }
```

Writes `content` verbatim to
`~/.local/share/nanobrowser/artifacts/<runId>/<filename>`, creating both directories as
needed, mode `0600`. The extension already validated `filename` (basename only, an
allowed extension, no separators, no `..`) before it ever sent this, but the host never
trusts a client-supplied path: `filename` is re-validated from scratch (`bad_request` on a
separator or `..`) and `runId` goes through the same `[A-Za-z0-9_-]{1,64}` check
`runlog.append` uses. `content` over 8 MiB (`MAX_ARTIFACT_BYTES`) is `bad_request` rather
than written partially.

### `log.append` → `log.ack`

```json
{ "type": "log.append", "id": "g1", "level": "error", "source": "worker",
  "message": "uncaught: cannot read properties of null", "stack": "at step (chunk.js:41)", "at": 1767225600000 }
{ "type": "log.ack", "id": "g1", "ok": true }
```

Appends one JSON line to `~/.local/share/nanobrowser/ext.log`, and mirrors `error` entries
into `host.log` prefixed `[ext:<source>]` so one tail shows both sides of a failure.

`level` is `error` | `warn` | `info`; `source` is `worker` | `panel`. Anything else is
`bad_request` and nothing is written. `at` is epoch ms taken in the extension; a missing
one defaults to the host's clock. `id` is optional — like `runlog.append`, this is
fire-and-forget, and the extension does not wait for the ack.

This exists because an extension-side error is otherwise visible only on the
`chrome://extensions` page, which nothing is watching during an unattended run.

The extension redacts (`redactText`, `src/host/redact.ts`) before it posts, and the host
redacts the serialized line again before it writes: neither side trusts the other with a
secret (R-12). Nothing matching `sk-or-` survives either pass.

Read it with `host/bin/nb-logs [--since <iso>] [--level error|warn|info] [--json]`, which
reads the file directly rather than the socket — the log outlives every host process, and
after a reload the host that saw the error is already gone.

### `input.moveTo` | `input.click` | `input.typeText` | `input.key` → `input.result`

```json
{ "type": "input.moveTo",  "id": "i1", "x": 100, "y": 200 }
{ "type": "input.click",   "id": "i2", "button": "left" }
{ "type": "input.typeText","id": "i3", "text": "hello" }
{ "type": "input.key",     "id": "i4", "name": "Enter", "action": "press" }

{ "type": "input.result", "id": "i1", "ok": true,  "injector": "wayland" }
{ "type": "input.result", "id": "i1", "ok": false, "injector": "null",
  "reason": "input injection is not available in this build (moveTo)" }
```

`button` is `left` | `right` | `middle`; `action` is `down` | `up` | `press`.

The shipped injector is `NullInjector`, which **rejects every call** rather than silently
no-opping, so a caller can never mistake "not implemented" for "done". `host/src/input/index.ts`
exports the `InputInjector` interface and `setInjector()`; the Wayland/uinput implementation is a
separate piece of work and needs no protocol change.

### host → extension: `run.start`

Pushed by the host, not requested by the extension. Only ever emitted by the dev trigger.

```json
{ "type": "run.start", "runId": "run-mgh1-9f3c", "prompt": "…", "url": "https://…", "options": { "navMode": "dom" } }
```

The extension starts the run **with the side panel closed** (`sidePanel.open()` needs a user
gesture) and streams every event back via `runlog.append`.

### host → extension: `ext.reload`

Pushed by the host, not requested by the extension. Only ever emitted by the dev socket's
`reload` op.

```json
{ "type": "ext.reload" }
```

The worker answers with `chrome.runtime.reload()`, which **re-reads an unpacked extension
from disk** — so `pnpm build` followed by this needs no human click on
`chrome://extensions`. It also tears the service worker down, which drops the native port,
which kills the host process that sent it. Nothing after the push runs, on either side.

## Dev trigger (unix socket)

Bound only when `NANOBROWSER_DEV=1` (or `--dev`, which `install.sh --dev` bakes into the wrapper).
Path: `$XDG_RUNTIME_DIR/nanobrowser.sock`, mode `0600`, unlinked on exit and re-bound over a
stale file. Override with `NANOBROWSER_SOCK`.

A unix socket rather than a loopback TCP port: it is filesystem-permissioned, outside the network
namespace, and unreachable from any page in the browser. It is a control channel that drives the
agent as the user — hence dev-only.

Line protocol is **NDJSON** (one JSON object per line), not native-messaging framing.

Client → host:

```json
{ "op": "status" }
{ "op": "run", "prompt": "…", "url": "https://…", "runId": "optional", "options": { … } }
{ "op": "reload" }
```

Host → client:

```json
{ "op": "status", "ok": true, "extensionConnected": true, "hostVersion": "0.0.1", "pid": 12345, "key": { "ready": true } }
{ "op": "reloading", "pid": 12345 }
{ "op": "accepted", "runId": "run-mgh1-9f3c" }
{ "op": "event", "runId": "run-mgh1-9f3c", "event": { … } }
{ "op": "end", "runId": "run-mgh1-9f3c" }
{ "op": "error", "message": "no extension connected to the host" }
```

`run` and `reload` are both refused when no extension has connected.

`reload` answers `reloading` **before** it pushes `ext.reload`, because the push kills this
host: there is no "after". `pid` is this host process, and it is how a caller tells a new
host from the one it just asked to die — `nb-reload` polls `status` until the pid has
changed *and* `extensionConnected` is true again.
 After `accepted`, the client receives one
`event` per `runlog.append` for that run, then `end` once an event with `type: "run.end"` passes
through, and the socket closes. A generated `runId` looks like `run-<base36 ms>-<8 hex>` and
always satisfies the `runId` grammar.

CLIs:

| CLI | What it does |
| --- | --- |
| `nb-run "<prompt>" [--url <url>] [--run-id <id>] [--option k=v]` | streams the run log to stdout |
| `nb-status` | prints the status object; exits non-zero unless the key is ready |
| `nb-reload [--timeout <s>]` | reloads the extension in place; exits 0 with the new host pid, 2 if no extension is connected, 1 on timeout (default 30 s) |
| `nb-logs [--since <iso>] [--level <level>] [--json] [--file <path>]` | prints `ext.log` entries |

`scripts/e2e.sh` chains the first four into one unattended loop; see
`docs/research/live-testing-real-chrome.md` § Unattended testing.

## Cassettes

`NANOBROWSER_CASSETTE=record|replay`, off by default. Directory: `host/cassettes/`
(`NANOBROWSER_CASSETTE_DIR` overrides).

The key is `sha256` of a canonical, recursively key-sorted JSON of exactly
`{ url, model, messages }` — the normalized API path, `body.model`, and `body.messages`. Sampling
knobs, `stream`, and provider preferences deliberately do not participate, so an unrelated
request-shape tweak does not invalidate a recording. File: `<key>.json`.

```json
{ "key": "<sha256>", "url": "chat/completions", "model": "…", "status": 200,
  "headers": { … }, "chunks": ["<base64>", "…"] }
```

`record` performs the real request, streams to the extension as usual, and writes the entry when
the stream ends. Writing the entry is best-effort: `llm.end` has already gone out, so a failed
write (disk full, permissions, a refused non-regular file) is logged as a warning in `host.log` and
never produces a second terminal message for the same `id`. `replay` makes **no network call and
needs no secret**: it emits the recorded chunks then `llm.end`. A request with no matching cassette
fails loudly with `llm.error` / `cassette_miss` — it never silently falls through to the network.

## Secrets

`OPENROUTER_API_KEY` and `KILO_CODE_API_KEY` are each fetched once at startup, in parallel, with
`doppler secrets get <NAME> --plain -p ai-automation -c dev`
(project/config overridable via `NANOBROWSER_DOPPLER_PROJECT` / `NANOBROWSER_DOPPLER_CONFIG` —
one project/config pair covers both secrets, matching where the user's Doppler already keeps
them). Either one being absent is independent of the other: neither crashes the host, and each
source's readiness is tracked separately (`SecretStore.status('openrouter' | 'kilo')` in
`host/src/secrets.ts`). Both live in process-local variables only: never written to disk, never
logged, never echoed, and never sent to the extension. Rotation means restarting the host, which
happens once per `connectNative` session anyway.

`SecretProvider` in `host/src/secrets.ts` is the single seam — C-06 names OpenBao and the OS
keychain as successors, and swapping the backend must not touch this protocol or the extension.
Tests use `FakeSecretProvider` and never reach a real store.

The wire-level `key.status` message (above) still validates OpenRouter specifically, with a live
`GET /key` — Kilo has no documented equivalent validation endpoint, so its readiness is
presence-only (`SecretStore.status('kilo')`), not a round trip.

## Environment

| Variable | Effect |
| --- | --- |
| `NANOBROWSER_DEV=1` | bind the dev trigger socket (also `--dev`) |
| `NANOBROWSER_SOCK` | override the socket path |
| `NANOBROWSER_CASSETTE` | `record` \| `replay`; anything else is off |
| `NANOBROWSER_CASSETTE_DIR` | override `host/cassettes/` |
| `NANOBROWSER_DOPPLER_PROJECT` / `_CONFIG` | override `ai-automation` / `dev` |
| `NANOBROWSER_LOG_STDERR=0` | log to file only |
| `NB_RELOAD_TIMEOUT` | nb-reload's default wait in seconds (30) |
| `NB_HOME` | move the whole home-relative tree (install.sh, tests) |
