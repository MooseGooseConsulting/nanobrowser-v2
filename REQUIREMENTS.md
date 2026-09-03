# Requirements

Canonical. Every line came from the user. Nothing here was inferred by an agent.

Supersedes `drop/handoff/specs/001-modernize-nano-browser/`, `docs/adr/*`, and any
claim made in a README.

**Requirements** are what the architecture must do. They are the measures of success.
**Requirements to investigate** are things we know we need and do not yet know how to
build. They are requirements; the investigation is the work.
**Constraints** are decisions to comply with while choosing how. They are not measures
of success, and meeting one does not mean anything was delivered.

Order here is not priority. Sequencing is decided separately.

Agents: do not add, remove, reword, or reinterpret anything in this file. Do not
promote an engineering idea into it. Open items are at the end — ask, do not decide.

## Requirements

- **R-01** A Chrome extension that acts on the tab the user already has open.
- **R-02** Low observability. The agent's presence and its actions are not detectable by the site.
- **R-03** Leader/Follower: a planner decomposes the objective; a fast follower acts and can return control on its own signal (`CONTINUE | SUBGOAL_COMPLETE | RETURN_TO_LEADER | BLOCKED`), not only on a turn count.
- **R-04** The Leader's re-plan cadence is a deterministic, configurable control (`planningInterval`). `maxSteps` is a safety valve, not the normal handoff.
- **R-05** The side panel is the primary surface. The user there is the boss.
- **R-06** A modern side-panel UI that shows tool calls.
- **R-07** A visible log of the run as it moves, including control moving between Leader and Follower.
- **R-08** Navigation by DOM and navigation by pixels are both supported, and the choice is the user's in the side panel: `dom | pixels | both`.
- **R-09** The agent can execute userscripts live.
- **R-10** The agent can debug userscripts live.
- **R-11** Models are chosen in the side panel, with the Leader model and the Follower model selected separately. Provider and model configuration is easy to set up, can be saved and restored, and reports validated readiness rather than assumed readiness.
- **R-12** The user's credentials are never exposed by the extension.
- **R-13** Input fidelity is escalatable. Default to in-page input; escalate to debugger/CDP-backed trusted input when a site requires it, as a toggle or an explicit escalation rather than the standing mode.

## Requirements to investigate

- **I-01** How to satisfy R-13 without giving up R-02.
  *Known:* inside an extension, content-script events are always `isTrusted: false`. The only source of trusted input is `chrome.debugger` + CDP `Input`, and attaching raises the debugging banner. No content-script API exists; requests for one have been declined upstream.
  *Unknown:* whether the banner can be suppressed or made acceptable, whether escalation can attach per-action and detach immediately, and what either costs in observability.
- **I-02** Which sites actually require trusted input, and for what. R-13's escalation is only worth its cost where `isTrusted: false` genuinely fails.
- **I-03** Whether R-09/R-10 can route around R-13 entirely by calling the page's own APIs instead of synthesizing input.

## Constraints

- **C-01** MV3, or whatever extension harness gives the best stealth.
- **C-02** The agent loop comes from the framework (LangGraph). Do not roll our own.
- **C-03** No deprecated framework APIs.
- **C-04** Libraries are chosen on adoption and by reading their code, not on a search result.
- **C-05** Set-of-marks is optional. It is not the interaction model.
- **C-06** Secrets currently live in the desktop secret store — Doppler now, OpenBao or OS keychain later — and the extension holds none. This is the current answer to R-12, not a goal in itself; replace it if something better satisfies R-12.
- **C-07** Whatever holds the key does not choose the model. Model selection belongs to the side panel (R-11).

## Not requirements

- **N-01** Human-in-the-loop. Approval gates are not a first-cast requirement.
- **N-02** Outside control of the run by a model or by MCP. A message bus may come later.
- **N-03** New frameworks.

## Acceptance

- **A-01** Tests cover the requirements above.

## Open — ask, do not decide

- **O-01** R-01–R-13 are "just the beginning." What else belongs here?
- **O-02** Sequencing. What is built first?
- **O-03** What does "debug userscripts live" include — edit and re-run in place, read console and errors, breakpoints, something else?
- **O-04** SAM 3 as an optional second mark generator: never answered.
- **O-05** "navigate, plan, download" were named once as Follower tools. Do they belong as requirements?
- **O-06** Which providers must be selectable in the side panel, and does the Follower need a vision-capable model by default?

## Provenance

| Item | Source |
| --- | --- |
| R-01, R-02, R-03, R-06, R-09, R-10, C-01 | "a chrome extension, with low observability, a leader follower pattern, a modern ui that shows tool calls, MV3 or whatever harness is best stealth, the ability for an agent to execute and debug userscripts live" — 2026-09-03 |
| R-01, R-05, N-02 | "this isn't being driven from outside by a model or by MCP… chatting in the sidebar, while that leader follower has the tools to navigate, plan, download, run userscripts and debug userscripts, that's the primary purpose." — 2026-09-03 02:24 |
| R-03 | Spec FR-004; Follower-initiated return, fixed cadence not the only handoff |
| R-04 | "2. Yes, replan every n steps." — 2026-09-03 02:37 |
| R-07 | Spec FR-006: "Is there any way we can have a log of it as it moves along?" |
| R-08 | "we're doing dom, instead of pixels? can we have that please be swappable at least?" — 2026-09-03 12:02 |
| R-08, R-11, C-07 | "I'd like to choose the models in the side panel (did you forget leader follower) and like to have the choice between dom, and pixel nav" — 2026-09-03 |
| R-11 | Spec User Story 1 / FR-001, FR-002 |
| R-12, C-06 | "doppler for now, eventually openbao or something? os keychain rporbably best" — 2026-09-03 02:37; typed as a constraint per "how it manages secrets… isn't a goal" — 2026-09-03 |
| R-13, I-01 | "if it's hard to do, then we just have it be a toggle or an escallation to to use the debugger and CDP. if we don't know how to do THIS IT SOUNDS LIKE A REQUIREMENT TO INVESTIGATE" — 2026-09-03 |
| C-02 | "last thing I want to do is roll our own version of this…. this is something that comes from the framework i hope" — 2026-09-03 02:24 |
| C-03 | "if we're using depreciated commands, that doesn't speak well to our archetecting of it" — 2026-09-03 06:26 |
| C-04 | "you don't have star count, adoption, or read the code" — 2026-09-03 06:36 |
| C-05 | "isn't marks supposed to be optional? most models can rely on the raw pixels" — 2026-09-03 02:24 |
| N-01 | "i don't need anything that's fucking 'human in the loop'" / "not a first cast requirements" — 2026-09-03 06:43, 06:47 |
| N-03 | "and no, I don't want no new frameworks" — 2026-09-03 06:37 |
| A-01 | "none of the various attempts have tests that complete everything" — 2026-09-03 17:09 |
| O-02 | "just because its' core, doesn't mean it should happen first" — 2026-09-03 |
