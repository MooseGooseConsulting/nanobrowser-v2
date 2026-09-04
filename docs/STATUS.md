# Status against REQUIREMENTS.md

One row per item in `REQUIREMENTS.md`, as of the integration of the subsystems into a
working service worker. `REQUIREMENTS.md` is canonical and untouched; this file only
reports against it.

Status is **done** (built and proved by a test), **partial** (built, but something the
item asks for is missing — the note says what), or **open** (not built).

Test names below are the `it(...)` text in the named file. `pnpm test` runs everything
under `tests/`, `src/` and `entrypoints/` (66 files, 1408 tests) and then
`scripts/check-invariants.sh`. The native host has its own suite under `host/` with its
own vitest config (8 files, 122 tests); it is **not** part of the root `pnpm test` run.

## Requirements

| Item | Status | Implementing file(s) | Proving test(s) | Notes |
| --- | --- | --- | --- | --- |
| **R-01** Acts on the tab the user already has open | done | `src/runtime/runManager.ts` (`chromeTabsPort`, `refuseReason`), `src/page/driver.ts` | `src/runtime/runManager.test.ts`: "acts on the active tab of the last focused window and names it in run.started (R-01)", "refuses a chrome:// tab with a run.ended error rather than starting", "refuses the side panel itself" | No tab is ever created; the active tab of the last focused normal window is the target, and browser/extension pages are refused with a clear `run.ended{error}`. |
| **R-02** Low observability | partial | `scripts/check-invariants.sh`, `src/page/actions.ts`, `src/page/driver.ts` (on-demand injection), `src/input/humanize.ts`, `wxt.config.ts` | `scripts/check-invariants.sh` (4 manifest/source invariants); `tests/page-actions.test.ts`: "attaches nothing to the document or window", "leaves no listener, timer or observer in the source at all", "every event it emits is isTrusted:false — the R-13 tier-1 tell"; `tests/page-handler.test.ts`: "adds no global to the page and no node to the DOM"; `tests/page-driver.test.ts`: "does not inject at all when the ping already answers" | Every structural tell is closed and guarded. Not proved against a real detector: no live run has been made (see the e2e row), so "not detectable by the site" is asserted from code review plus `docs/research/bot-detection-research.md`, not measured. |
| **R-03** Leader/Follower with a Follower-initiated signal | done | `src/agent/graph.ts`, `src/agent/tools.ts` (`controlEnvelope`) | `src/agent/graph.test.ts`: "ends the run on BLOCKED without returning to the leader", "keeps the leader and follower message histories separate"; `src/runtime/smoke.test.ts`: "produces the run log the side panel renders, in order" | The four-value vocabulary is verbatim. The signal rides on the tool call's own arguments (see assumptions), so control returns without a turn-count trigger. |
| **R-04** Deterministic `planningInterval`, `maxSteps` as a safety valve | done | `src/agent/graph.ts` (`decideNext`), `src/agent/state.ts` | `src/agent/graph.test.ts`: "replans exactly every planningInterval follower steps"; `src/agent/run.test.ts`: "ends with max-steps after exactly maxSteps follower steps" | Both are user-set in the panel and validated there (`src/ui/state/gate.test.ts`: "rejects out-of-range or non-integer cadence values"). |
| **R-05** The side panel is the primary surface | done | `entrypoints/sidepanel/*`, `src/ui/sections/*`, `src/ui/runlog/RunResultCard.tsx`, `src/ui/runlog/StepSection.tsx`, `src/runtime/worker.ts` | `src/ui/sections/RunSection.test.tsx`: "offers Pause and Abort while running, not Resume", "re-enables Run and hides transport controls once the run ends", "submits with Ctrl+Enter", "is an aria-live region showing state, step N of maxSteps, and the current subgoal", "groups a Follower step behind a collapsible \"Step N\" section, open by default"; `src/ui/runlog/RunResultCard.test.tsx`: "shows outcome, summary, steps and elapsed time"; `src/runtime/worker.test.ts`: "greets a panel on connect and answers its heartbeat" | The panel opens on the toolbar action; pause/resume/abort delegate to the live run. |
| **R-06** Modern side-panel UI that shows tool calls | done | `src/ui/runlog/ToolCallCard.tsx`, `src/ui/runlog/RunLog.tsx` | `src/ui/runlog/ToolCallCard.test.tsx`: "starts collapsed, showing name, outcome and duration only", "expands on click and pretty-prints the arguments", "marks a failed call"; `src/agent/graph.test.ts`: "emits tool.call then tool.result in order with matching callIds" | |
| **R-07** A visible log of the run, including control moving between roles | done | `src/runtime/runManager.ts` (fan-out + ring buffer), `src/ui/runlog/HandoffCard.tsx`, `src/ui/state/runlog.ts` | `src/runtime/worker.test.ts`: "fans every run event out to every panel and to the host run log (R-07)", "replays the buffered log for a reopened panel"; `src/ui/runlog/HandoffCard.test.tsx`: "names both roles, the direction, the reason and the signal" | Every event goes three ways: all connected panels, `hostClient.appendRunLog` (redacted inside the client), and a 2000-event ring buffer per run that backs `runlog.replay`. |
| **R-08** `dom \| pixels \| both`, chosen by the user | done | `src/storage/config.ts`, `src/agent/graph.ts` (observe block), `src/runtime/pageTools.ts` | `src/agent/graph.test.ts`: "sends an image content block in pixels mode and none in dom mode"; `src/ui/sections/SetupSection.test.tsx`: "writes every change to the Config storage item" | The mode is read from the panel's `Config` on every run; the snapshot budget follows it (`snapshotBudget`). |
| **R-09** The agent can execute userscripts live | done | `src/userscripts/runner.ts`, `src/runtime/pageTools.ts` (`runUserscript` tool), `entrypoints/background.ts` | `src/userscripts/runner.test.ts`: "injects into the USER_SCRIPT world, immediately, in the named tab", "returns the script value and the captured console lines"; `src/runtime/pageTools.test.ts`: "emits userscript console lines into the run log (R-07/R-09)" | The Follower's `run_userscript` tool runs a stored script against the run's tab; its console lines become `userscript.output` events. |
| **R-10** The agent can debug userscripts live | partial | `src/userscripts/debug.ts` (`DebugSession`), `src/ui/sections/UserscriptsSection.tsx` | `src/userscripts/debug.test.ts`: "re-runs edited code in place and replaces the previous result", "exposes the last run as run-log events, with the error line mapped back"; `src/ui/sections/UserscriptsSection.test.tsx`: "sends the live editor code on Run, without saving first (O-03)" | Edit-and-re-run in place, console capture by level, and errors mapped back to the user's own line/column. Missing: breakpoints and step debugging (impossible from an extension — `docs/research/i03-userscript-page-access.md`), and the *agent* can only run a stored script by id; edit-and-re-run is panel-driven. O-03 is still unanswered by the user. |
| **R-11** Models chosen in the panel, Leader and Follower separately, validated readiness | done | `src/ui/components/ModelSelect.tsx`, `src/ui/components/Combobox.tsx`, `src/ui/state/models.ts`, `src/ui/state/modelFilter.ts`, `src/storage/config.ts`, `src/runtime/worker.ts` (`models.list`, `readiness.get`), `src/runtime/runManager.ts` | `src/runtime/worker.test.ts`: "answers from the host and then from the cache for ten minutes", "maps a host-connection failure to an actionable reason", "passes a validated readiness through unchanged (R-11)"; `src/runtime/runManager.test.ts`: "builds the leader and the follower models separately (R-11/C-07)"; `src/ui/components/ModelSelect.test.tsx`: "keeps Leader and Follower selections independent", "shows the stored model id even before the catalog loads", "flags a stored id that is not in a loaded catalog, distinctly from still-loading"; `src/ui/sections/SetupSection.test.tsx`: "defaults on and hides paid models from the picker", "reveals paid models once turned off", "warns when a paid model is picked", "never keeps an existing paid selection out of view: it still resolves, just is not offered as a new pick"; `src/ui/state/modelFilter.test.tsx`: "defaults on, per the enforced norm" | Readiness is the host's validated `GET /key` answer, never assumed; config is saved to and restored from `local:config`. |
| **R-12** Credentials never exposed by the extension | done | `src/host/fetch.ts`, `src/host/redact.ts`, `host/src/secrets.ts`, `host/src/llm.ts` | `src/host/fetch.test.ts`: "never forwards a client-supplied Authorization header", "rejects an off-origin URL locally, without sending a message"; `src/host/redact.test.ts`: "strips an OpenRouter key wherever it appears, nested in unknown args"; `host/test/dispatcher.test.ts`: "reports ready when GET /key succeeds, and never sends the key to the panel" | The extension holds no key and adds no `Authorization`; the host attaches it. Run-log events are redacted before they leave the extension. |
| **R-13** Escalatable input fidelity, default in-page | done | `src/input/*`, `src/runtime/pageTools.ts` (`EscalatableInput`) | `src/runtime/pageTools.test.ts`: "routes to the in-page tier by ref when fidelity is in-page", "routes to the debugger tier by viewport point when fidelity is escalated", "attaches the debugger tier once for the whole run and detaches at the end", "falls back to the in-page tier for the rest of the run when the user detaches"; `tests/input/debugger.test.ts`: "never sends Runtime/Page/DOM/Emulation commands across a mixed run" | Escalation is the user's explicit toggle in the panel, never the standing mode. Attach happens once per run and detach once at `run.ended`; a user-cancelled banner is a one-way fallback to in-page, logged as `input.fidelity{attached:false}`. Never exercised against a real Chrome (see the e2e row). |

## Requirements to investigate

| Item | Status | Implementing file(s) | Proving test(s) | Notes |
| --- | --- | --- | --- | --- |
| **I-01** Satisfy R-13 without giving up R-02 | partial | `docs/research/trusted-input-and-stealth.md` §§1–3, 6; `docs/research/bot-detection-research.md` §D.3 + ranked leaks 6–7; `docs/research/stealth-harness-landscape.md` §§6–7; built as `src/input/debugger.ts` + `EscalatableInput` | `tests/input/debugger.test.ts` (attach-once, `Input`-domain-only, onDetach semantics); `src/runtime/pageTools.test.ts` (escalation + fallback) | All three named unknowns are answered **qualitatively**: the banner cannot be suppressed by any shippable means (`--silent-debugger-extension-api` / policy install only); per-action attach is decisively the wrong pattern (`kAutoCloseDelay = 5s`, browser-wide infobar); attach itself issues no CDP command. Missing: nothing is **measured** — attach latency and the infobar's viewport delta are source-derived and flagged unmeasured, and no evidence exists that any vendor detects attachment. The banner-free alternative the docs recommend (Wayland `zwlr_virtual_pointer_v1` via the native host, `host/src/input/`) is a stub that has never been executed. |
| **I-02** Which sites actually require trusted input | partial | `docs/research/trusted-input-and-stealth.md` §5; `docs/research/bot-detection-research.md` Part C + §A.6 | — (no test; this is a finding, not code) | The **API class** is fully pinned: the activation-gated set (~30 APIs), the sticky/transient activation rules, the post-Chrome-53 default-action rule with `click` grandfathered, and the read of ~60 checks across five detectors showing exactly one (`isTrusted`) fires in in-page mode. Missing is the requirement's literal question — *which sites*: there is no site list, no probe run against a real target, and no prevalence figure for `isTrusted`/`userActivation` checks. Drag-and-drop, payment iframes and the big login flows are explicitly unverified, and per-site `e.isTrusted` guards are conceded to be non-enumerable. The live e2e run is the first thing that would move this. |
| **I-03** Whether R-09/R-10 can route around R-13 via the page's own APIs | done | `docs/research/i03-userscript-page-access.md`; probe in `src/userscripts/i03.ts` | `src/userscripts/i03.test.ts`: "reports what the world can reach on the page", "gates the one network request behind an explicit opt-in" | Answered in both directions with running code: **yes** for same-origin credentialed `fetch` (HttpOnly cookies ride along without being exposed), DOM-derived CSRF tokens and CSP-exempt injection; **no** for the page's own heap/globals, cross-origin without CORS, HttpOnly values, trusted input and breakpoints. Caveat worth settling: `docs/research/stealth-harness-landscape.md` §1 advises against `chrome.userScripts` (Chrome 138+ per-extension toggle, off by default) while I-03 is built on it, and `docs/research/userscripts-api.md` still recommends `world:'MAIN'`, which `check-invariants.sh` forbids. |

## Constraints

| Item | Status | Implementing file(s) | Proving test(s) | Notes |
| --- | --- | --- | --- | --- |
| **C-01** MV3 (or the best-stealth harness) | done | `wxt.config.ts`, `.output/chrome-mv3/manifest.json`, `docs/research/extension-stack.md`, `docs/research/stealth-harness-landscape.md` | `scripts/check-invariants.sh` | MV3 chosen after the harness survey; the manifest declares no `web_accessible_resources`, no `externally_connectable` and no `content_scripts`. |
| **C-02** The agent loop comes from LangGraph | done | `src/agent/graph.ts`, `src/agent/run.ts`, `src/agent/checkpointer.ts` | `src/agent/run.test.ts`: "drains at a step boundary and resumes from the checkpoint with the step count intact"; `src/agent/checkpointer.test.ts` (the vendor's checkpoint validation suite) | Supersteps, routing, checkpointing and drain all come from `@langchain/langgraph/web`; nothing re-implements the loop. |
| **C-03** No deprecated framework APIs | done | `src/agent/state.ts` (`StateSchema`, not `Annotation.Root`), `src/agent/graph.ts` (no `createReactAgent`, no `interrupt()`), `src/agent/models.ts` (`ContentBlock`, not `image_url`) | `pnpm typecheck` (the deprecated surfaces are gone in the pinned versions, so `tsc` is the guard); `src/agent/graph.test.ts`: "sends an image content block in pixels mode and none in dom mode" | No standalone lint rule enforces this; the choice is recorded in `docs/research/langgraph.md`. |
| **C-04** Libraries chosen on adoption and by reading the code | done | `docs/research/extension-stack.md`, `docs/research/langgraph.md`, `docs/research/userscripts-api.md` | — | Each dependency in `package.json` is justified in a research doc that cites the library's own source, not a search result. |
| **C-05** Set-of-marks is optional, not the interaction model | done | `src/agent/tools.ts`, `src/page/snapshot.ts` | `src/agent/graph.test.ts`: "sends an image content block in pixels mode and none in dom mode"; `tests/page-snapshot.test.ts`: "gives one element exactly one ref within a snapshot, and resolves it" | Interaction is by accessibility-tree `[ref=eNN]`; the pixel mode sends a plain screenshot with no marks drawn. Nothing overlays the page. |
| **C-06** Secrets live in the desktop store; the extension holds none | done | `host/src/secrets.ts` (`DopplerSecretProvider`), `src/host/fetch.ts` | `host/test/dispatcher.test.ts`: "emits llm.error no_key when no secret is available, without calling fetch", "strips a client-supplied Authorization header rather than forwarding it" | Doppler today behind a one-method `SecretProvider` seam, so OpenBao or an OS keychain is a swap that touches no protocol. |
| **C-07** Whatever holds the key does not choose the model | done | `src/runtime/runManager.ts` (`createModel` per role), `src/agent/models.ts`, `host/src/llm.ts` | `src/runtime/runManager.test.ts`: "builds the leader and the follower models separately (R-11/C-07)"; `host/test/dispatcher.test.ts`: "passes GET /models through with no Authorization header" | The host proxies the request body verbatim and never rewrites `model`; the panel's two selections are the only source. |

## Not requirements

| Item | Status | Implementing file(s) | Proving test(s) | Notes |
| --- | --- | --- | --- | --- |
| **N-01** No human-in-the-loop | done (honoured) | `src/agent/graph.ts`, `src/agent/run.ts` | `src/agent/run.test.ts`: "ends with max-steps after exactly maxSteps follower steps" (the run needs no approval to proceed) | No approval gate anywhere; `interrupt()` is not used. Pause/resume exists only because the user asked for transport controls, and it is user-initiated, never agent-initiated. |
| **N-02** No outside control of the run by a model or MCP | done (honoured), with one caveat | `wxt.config.ts` (no `externally_connectable`), `host/src/trigger.ts`, `src/runtime/worker.ts` | `scripts/check-invariants.sh`: "manifest has no externally_connectable"; `host/test/trigger.test.ts`: "binds with mode 0600" | Nothing on the web can reach the extension. The caveat: the host's dev trigger *can* start a run from outside (unix socket, mode 0600, bound only under `NANOBROWSER_DEV=1`). It is a developer affordance driven by the user's own CLI, not a model or MCP — but it is the one thing in the build that sits near this line, and it should be looked at if that is not wanted. |
| **N-03** No new frameworks | done (honoured) | `package.json` | — | The dependency set is LangChain/LangGraph, React, WXT, zod, idb — all previously chosen. This integration added no dependency at all. |

## Acceptance

| Item | Status | Implementing file(s) | Proving test(s) | Notes |
| --- | --- | --- | --- | --- |
| **A-01** Tests cover the requirements above | partial | all `*.test.ts(x)` under `src/`, `tests/`, plus `host/test/` | `pnpm test`: 39 files, 1158 tests, then 4 stealth invariants | Every R and C item has at least one named proving test. The gaps are the two partial investigations (I-01 measurement, I-02 site evidence) and the fact that nothing has ever run against a real browser or a real model. |
| **Live e2e** (real Chrome, real host, Hyperagent) | done | `host/bin/nb-run`, `src/runtime/worker.ts` (dev trigger), `entrypoints/background.ts` | Terminal output pasted under "Live e2e evidence" below; host run log `~/.local/share/nanobrowser/runs/run-mtm338dy-a0e8242e.jsonl` | Ran 2026-09-03 in the user's real Chrome 152 (default profile, logged in) against hyperagent.com with `observe=dom`, `inputFidelity=in-page`. Read-only task completed in one Follower step from a 1443-token snapshot. Models for this run were paid (`deepseek/deepseek-v3.2` Leader, `z-ai/glm-5.3-flash` Follower) because the loaded build still sent `data_collection:"deny"`, which excludes every `:free` endpoint (first attempt, `run-mtm2coon-54484f60`, ended `error 404 No endpoints found matching your data policy`); fixed in `src/agent/models.ts` (`dataCollectionFor`), free-model rerun done (see Run 3 below). |

## Deviations and assumptions

Open items are the user's to answer (`REQUIREMENTS.md` says ask, do not decide). The
build could not stall on them, so each one was taken as a **reversible assumption**,
recorded here. None of them changed `REQUIREMENTS.md`.

1. **O-05 — `navigate`, `plan`, `download` as Follower tools.** Assumed yes: `navigate`
   and `download` are Follower tools (`src/agent/tools.ts`), and `plan` is the Leader's
   only tool (`set_plan`) rather than a Follower one. Consequence: `downloads` was added
   to the manifest permissions in `wxt.config.ts` — without it `chrome.downloads` is
   absent and `PageDriver.download` refuses. Reversing this means dropping two tools and
   the permission.
2. **O-05 (download semantics).** `download` takes a full URL *or* an element ref. A URL
   goes to `chrome.downloads`; a ref is clicked through the input tier and the page
   starts its own download, because no driver op can read a link's `href`.
3. **O-03 — what "debug userscripts live" includes.** Assumed edit-and-re-run in place
   plus console and error capture, with errors mapped back to the user's own line and
   column. **No breakpoints and no stepping**: an extension cannot attach a JS debugger
   to a page it is scripting without `chrome.debugger`'s `Debugger` domain, which would
   violate the `Input`-domain-only rule the stealth research imposes.
4. **O-04 — SAM 3 as a second mark generator.** Not built. C-05 makes marks optional and
   the pixel mode sends an unannotated screenshot, so nothing depends on this answer yet.
5. **R-03 signal transport.** The Follower's control signal rides on the *arguments of
   the tool call it is already making* (`signal` / `note` on every tool schema), so one
   model round trip yields both the action and the classification. An absent `signal`
   means `CONTINUE`. The alternative — a second classification call per step — was
   rejected as a second LLM round trip per action.
6. **R-04 step accounting.** `stepCount` counts **Follower actions only**; Leader turns
   are not steps. So `maxSteps: 50` means fifty page actions, and `planningInterval: 5`
   means the Leader is consulted after every fifth action.
7. **R-09 userscript semantics.** Stored userscripts are function bodies: a top-level
   `return` is how a script yields its value, and the runner wraps the code so the user's
   first line stays at a known offset for error mapping.
8. **Fidelity fallback is one-way.** If the user cancels Chrome's debugging banner
   mid-run, the run continues on the in-page tier and never re-attaches, on the reading
   that cancelling the banner is the user saying no. The fallback is logged as
   `input.fidelity { attached: false }`.
9. **`select` is always the page tier.** No CDP `Input` command sets a `<select>`'s
   value, so `select` goes through the driver on both fidelities. Same for
   `scroll('top')` / `scroll('bottom')`, which are document jumps rather than synthesized
   input.
10. **Dev-trigger terminator.** The host closes a socket subscriber on a run-log event
    whose `type` is `run.end`, while every contract event is keyed by `kind`. The worker
    therefore appends one extra host-only `{ type: 'run.end', … }` record when a
    dev-triggered run finishes. No contract variant was added for this.
11. **O-05 — `save_file` as a Follower tool.** Two independent save paths, both taken on
    every call so one failing does not lose the other: `chrome.downloads.download` of a
    `data:` URL to `nanobrowser/<filename>` (`saveAs:false`, `conflictAction:'uniquify'`
    — `src/page/driver.ts` `PageDriver.saveFile`), and the host's new `artifact.save` op,
    writing to `~/.local/share/nanobrowser/artifacts/<runId>/<filename>` (`host/src/
    artifacts.ts`, wired in `host/src/dispatcher.ts`, documented in
    `docs/host-protocol.md`). The tool (`src/agent/tools.ts` `save_file`) validates the
    filename client-side (basename only, `.json`/`.txt`/`.csv`, no separators, no `..`,
    ≤100 chars — `validateSaveFilename`); the host re-validates independently
    (`assertFilename` in `host/src/artifacts.ts`) rather than trusting the client. A
    `run.ended`-style run-log event, `file.saved`, is added to the `RunEvent` union
    (`src/messaging/contract.ts`) and rendered by a new `src/ui/runlog/FileSavedCard.tsx`
    wired into `LogEntryView.tsx`. Proving tests: `src/agent/tools.edge.test.ts`
    ("save_file requires a well-formed filename", "save_file JSON.stringifies an object
    argument with 2-space indent"); `src/runtime/pageTools.test.ts` ("save_file downloads
    to the Downloads folder and emits a file.saved event", "save_file also writes to the
    host artifacts sink when available, and reports its path", "save_file refuses
    fromLastUserscript when nothing has run yet"); `host/test/artifacts.test.ts` and
    `host/test/dispatcher.test.ts` ("writes the file under <artifactsDir>/<runId>/
    <filename> and reports its byte count", "rejects a filename that escapes the run
    directory without writing anything").
12. **O-05 — `extract_text` as a Follower tool.** Not named in REQUIREMENTS.md; built
    because a text snapshot's node budget is the wrong tool for a long results list —
    see the maxNodes finding below. Implemented read-only in the injected ISOLATED-world
    code (`src/page/extractText.ts`), exposed through the existing handler/driver the
    same way `snapshot` is (`src/page/handler.ts`, `src/page/driver.ts`
    `PageDriver.extractText`). Prefers `main`, then `[role=main]`, then `article`, else
    the whole body; collapses whitespace; renders an anchor with an href and text as
    `"text (href)"`; `maxChars` (default 20000, hard cap 60000) with a trailing
    `" [truncated]"` marker. Proving tests: `src/page/extractText.test.ts` (unit
    behaviour); `tests/page-extract-text-ebay.test.ts` (against the eBay
    current-offerings fixture: "reads the `<main>` results list rather than the header
    chrome", "renders the item link as \"text (href)\"", "is whitespace-collapsed").


## Live e2e evidence

Run 2 (after the host connection-flag fix). Trigger from the CLI over the host's dev socket; every line
below is a run-log event streamed back from the extension, verbatim (long lines cut at 400 chars).

```
$ ./host/bin/nb-run "Read-only task. Look at the Threads sidebar on this Hyperagent page and report the titles and statuses of the 3 most recent threads. ..." \
    --option leaderModel=deepseek/deepseek-v3.2 --option followerModel=z-ai/glm-5.3-flash \
    --option observe=dom --option inputFidelity=in-page --option maxSteps=12 --option planningInterval=4
runId=run-mtm338dy-a0e8242e
{"kind":"input.fidelity","fidelity":"in-page","attached":false,"at":1788473743418}
{"kind":"run.started","runId":"run-mtm338dy-a0e8242e","prompt":"Read-only task. ...","config":{"leaderModel":"deepsee…
{"kind":"step","n":0,"role":"leader","at":1788473743432}
{"kind":"tool.call","role":"leader","call":{"callId":"31032932e49f4bbf96faf5f9dc8ec59c","name":"set_plan","args":{"plan":"First locate the Threads sidebar on the Hyperagent page. If it's collapsed, click to expand it to reveal the list of threads. Then identify the 3 most recent threads, read their titles and statuses, and report them.","subgoals":["Locate the Threads sidebar on the page","Expand …
{"kind":"tool.result","role":"leader","result":{"callId":"31032932e49f4bbf96faf5f9dc8ec59c","name":"set_plan","ok":true,"summary":"plan recorded: …","durationMs":1},"at":1788473750337}
{"kind":"leader.plan","plan":"First locate the Threads sidebar on the Hyperagent page. …","subgoals":[…],"replan":false,"at":1788473750337}
{"kind":"handoff","from":"leader","to":"follower","reason":"plan set; follower starts on subgoal 0","at":1788473750337}
{"kind":"step","n":1,"role":"follower","at":1788473750359}
{"kind":"observation","mode":"dom","tokens":1443,"hasScreenshot":false,"at":1788473750382}
{"kind":"model.text","role":"follower","text":"The Threads sidebar is already expanded (the \"Collapse threads\" button shows expanded=true), so the list is fully visible without any clicks. The three most recent threads appear at the top of the sidebar list, each with its status shown inline.","at":1788473809123}
{"kind":"tool.call","role":"follower","call":{"callId":"call-bc1a0a27-7ddb-4cf5-a2b9-526c30e9a962","name":"done","args":{"summary":"Located the Threads sidebar (already expanded, no clicks needed). The 3 most recent threads are: 1) \"google-stitch-ui-designer Thread\" — Waiting for your input; 2) \"UPS Selection for Network Gear\" — Waiting for your input; 3) \"SFF PC and eGPU Feasibility Analysis\" — Waiting for your input. Read-only; nothing was created, sent, edited, or deleted."}},"at":1788473809123}
{"kind":"tool.result","role":"follower","result":{"callId":"call-bc1a0a27-7ddb-4cf5-a2b9-526c30e9a962","name":"done","ok":true,"summary":"Located the Threads sidebar …","durationMs":0}}
{"kind":"follower.signal","signal":"SUBGOAL_COMPLETE","note":"Sidebar visible; three most recent threads and statuses captured.","at":1788473809123}
{"kind":"run.ended","status":"done","message":"objective complete","steps":1,"at":1788473809155}
{"type":"run.end","runId":"run-mtm338dy-a0e8242e","status":"done","message":"objective complete","steps":1,"at":1788473809155}
```

Host-side run log: `~/.local/share/nanobrowser/runs/run-mtm338dy-a0e8242e.jsonl`, 16 lines, zero occurrences of `sk-or` (R-12).

Run 1 (`run-mtm2coon-54484f60`, same prompt, `nvidia/nemotron-3-ultra-550b-a55b:free` / `nvidia/nemotron-3.5-lightning:free`):

```
{"kind":"run.ended","status":"error","message":"404 No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy ...","steps":0}
```

Cause and fix recorded in the Live e2e row above.

Run 3 (free models, unattended loop, 2026-09-03 23:11Z): `scripts/e2e.sh` did `pnpm build` → `nb-reload`
(extension self-reload via the host, new host pid) → `nb-status` → `nb-run` with
`nvidia/nemotron-3-ultra-550b-a55b:free` (Leader) and `nvidia/nemotron-3.5-lightning:free` (Follower),
`observe=dom`, `inputFidelity=in-page`. Stream saved to `runs/e2e-20260903T231115Z.jsonl` (gitignored).

```
=== result
run.ended.status = done
=== done summary
The three most recent threads from the Threads sidebar are: (1) "Vast.ai GPU Rental Data Reconciliation …" – status: Investigated live. (2) "Server Price Discovery via Scraping …" – status: Built and root-caused. (3) "DDR4 Server and Rack Recommendations …" – status: Researched and priced.
=== extension errors during this run
(none)
```

14 events: `input.fidelity → run.started → step → tool.call(set_plan) → tool.result → leader.plan → handoff → step → observation(1440 tokens) → tool.call(done) → tool.result → follower.signal(SUBGOAL_COMPLETE) → run.ended(done, 1 step) → run.end`.

Quality note, not a pipeline fault: the free Follower reported the three cards in the main "Recent threads"
section rather than the sidebar list, and invented "statuses" from the card descriptions. The paid run
(Run 2) read the sidebar correctly and reported the real "Waiting for your input" badges, which my
independent read of the page (Claude-in-Chrome) confirmed. Free Nemotron is good enough to drive the
loop; it is not as accurate on this task as the paid pair.

Between Run 2 and Run 3 two failures were found and fixed: the free endpoint intermittently answers
HTTP 200 with a body lacking `choices` (LangChain died with "reading 'message'"); `hardenOpenRouterFetch`
in `src/agent/models.ts` now rewrites error-in-200 bodies into real statuses so the SDK retries
(`maxRetries: 4`). Run-attempt `run-mtm4m1vo-be8ca635` is that failure, recorded in the host runs dir.

## Unattended testing loop

One manual `Load unpacked` was needed once. From then on: `scripts/e2e.sh` (build → self-reload →
status → run → assert → extension errors) runs with nobody at the keyboard. `host/bin/nb-logs` shows
worker/panel errors forwarded to `~/.local/share/nanobrowser/ext.log`; `host/bin/nb-reload` reloads the
extension from disk on demand.

## Suitability for the eBay DDR5 task

The task: "scrape and save a JSON of the first page of recently sold DDR5 from eBay, and
of the current offerings for DDR5 from eBay", unattended, on free models.

**Built and proved by a test:**

- **Current offerings** — `ebay-search-extract` (`src/userscripts/examples.ts`) parses
  eBay's live `.s-card` markup into `{ title, price, priceValue, currency, condition,
  buyingFormat, bids, shipping, location, seller, sellerFeedback, quantitySold, soldDate,
  url, itemId }`, skipping "Shop on eBay" placeholders, proved against
  `tests/fixtures/ebay-ddr5-current.html` (60 real listings + 2 placeholders, hand-written
  from the live probe) in `src/userscripts/examples.test.ts` — including the two exact
  card values the probe recorded (card 0 and card 5).
- **Sold/completed** — the same userscript also handles the legacy `.s-item` markup and a
  `Sold <date>` caption, proved against `tests/fixtures/ebay-ddr5-sold.html` (4 `.s-card` +
  3 `.s-item` real listings, mixed on purpose). The live probe found `LH_Sold=1&LH_Complete=1`
  redirects to `signin.ebay.com` when the user is not signed in — `tests/fixtures/
  ebay-signin.html` reproduces that wall, and the Follower system prompt (`src/agent/
  graph.ts`) now says explicitly: "If you land on a sign-in or login page, call blocked;
  never enter credentials." Whether the *live* sold search actually needs sign-in for this
  user's account is the one thing only a real run can answer — this build can only refuse
  correctly, not sidestep it.
- **Saving the result** — `run_userscript`'s own return is truncated at ~60000 chars, but
  the full untruncated array is retained and `save_file(fromLastUserscript:true)` writes it
  losslessly (`src/runtime/pageTools.test.ts`) to both `~/Downloads/nanobrowser/<filename>`
  and the host's `artifacts/<runId>/<filename>` (item 11 above).
- **Snapshot capacity** — measured directly against the current-offerings fixture
  (`tests/page-snapshot-ebay-budget.test.ts`): a full untruncated walk of 60 listings needs
  553 nodes; the historical default of 400 truncated before the last ~16 titles. Raised to
  900 (`DEFAULT_MAX_NODES`, `src/page/snapshot.ts`), which now captures every title with
  headroom for chrome this fixture does not model.
- **Surfacing the script** — `RunManager` seeds the bundled userscripts and filters them by
  the run's tab URL (`src/runtime/runManager.ts` `defaultListAvailableUserscripts`), so
  `ebay-search-extract` reaches the Follower's per-turn prompt automatically on an eBay
  search page with no panel setup required (`src/runtime/runManager.test.ts`: "surfaces the
  bundled ebay-search-extract userscript on an eBay search page by default").

**Still needs the live run to confirm:**

- Whether a free Leader/Follower pair actually completes this task end-to-end in the
  user's real Chrome (planning "go to eBay, search ddr5, run the extractor, save the
  file" from a one-line objective, choosing tool ids correctly, and stopping cleanly).
  Nothing here has been run against the real eBay.
- Whether the live sold-search page really does redirect to sign-in for this user's
  session (only checked once, per the task's own note), and whether `blocked` is what a
  small free Follower model actually emits when it happens, rather than trying to log in.
- The real DOM's exact attribute-span ordering and class names, which could not be
  fetched live (eBay's 403 challenge page) and are therefore reproduced from the user's
  own manual probe rather than scraped — a markup change on eBay's side would need a
  fixture update.
