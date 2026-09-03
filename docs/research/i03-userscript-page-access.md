# I-03 — What a userscript can reach from the page

Answer to **I-03** ("Whether R-09/R-10 can route around R-13 entirely by calling the page's
own APIs instead of synthesizing input"), from `docs/research/userscripts-api.md` plus the
implementation in `src/userscripts/`. `src/userscripts/i03.ts` is the executable half: run
`probePageAccess({ tabId })` on a real page to re-check the claims below.

## Where our scripts run

`chrome.userScripts.execute({ world: 'USER_SCRIPT' })`, Chrome 135+. `USER_SCRIPT` is an
extension-owned **isolated** world: it shares the tab's DOM but not the page's JavaScript
heap. We never ask for the page's own world (`MAIN`) — running as the page is the largest
detection signal a site has (R-02) — and `scripts/check-invariants.sh` enforces that.

## Yes: same-origin fetch, with the user's cookies

- The world shares the document's origin, so `fetch('/api/threads')` is a same-origin
  request from the page's own origin. `credentials: 'same-origin'` (the default) attaches
  the user's cookies, HttpOnly ones included — the browser attaches them; the script never
  sees their values. `SameSite` does not apply: same-origin, not cross-site.
- A CSRF token the page exposes to its own scripts *in the DOM* (meta tag, hidden input)
  is readable, because the DOM is shared. One held only in a page JS variable is not.

This is the part of I-03 that pays off: reading and writing through the site's own JSON
API needs no synthetic clicks or keystrokes at all.

## No: the page's JavaScript objects

The `USER_SCRIPT` world does **not** see page globals. A page-defined
`window.__APP_STATE__`, a Redux store, a live API-client instance: invisible.
`globalThis` is ours. This is the default and no option opens it — Chrome's only switch is
`world`, and the value that shares the page's heap is the page's own world, which R-02
rules out. `worldId` (Chrome 133+) subdivides our side and never crosses over;
`configureWorld({ csp, messaging, worldId })` tunes our world's CSP and message surface,
not its visibility into the page. So state the agent needs comes from the DOM or from the
site's API, never from page JS — the bundled `hyperagent-observe` example reads DOM only.

## CSP

Injection is exempt from the page's CSP: the `USER_SCRIPT` world carries its own, and the
page cannot block our code from running. What the code then does over standard web APIs
is not — a cross-origin `fetch` still needs CORS. We call
`configureWorld({ messaging: false, csp: undefined })` once: default CSP (no `unsafe-eval`
widening, since our scripts arrive and are injected as source) and no `chrome.*` surface,
because `execute()` already returns the script's value.

## Cannot do

- **Extension APIs** — with `messaging: false` there is no `chrome.runtime` or
  `chrome.tabs`. The script is a web-page script with a private heap.
- **Cross-origin requests without CORS** — same rules as the page's own code.
- **Read HttpOnly cookie values** — `document.cookie` omits them, by design.
- **Trusted input** — dispatched events are still `isTrusted: false`. I-03 routes *around*
  needing it for API-shaped work; it does not produce it. R-13/I-01 stay open.
- **Breakpoints** — they need `chrome.debugger`, whose permanent "started debugging this
  browser" infobar fails R-02, so O-03's loop is edit-and-re-run.

## What our wrapper captures

`runner.ts` runs the user's code as the body of an async function inside a capture wrapper
and returns a `UserscriptRunResult`:

- the returned value (a returned promise is awaited by Chrome);
- `console.log/info/debug/warn/error`, capped at 200 lines and 64 KiB, with an
  `[output truncated]` line when either cap bites;
- `error` and `unhandledrejection` events raised during the run;
- a thrown error, its line and column rebased onto the user's own source by subtracting
  the wrapper's known line offset, and the elapsed duration.

The wrapper restores `console` and removes both listeners in `finally`, leaves no globals
behind, and never writes to the DOM. Console lines become `userscript.output` run events
(`src/userscripts/debug.ts`), so R-07's log shows them in order.

## Verdict — partly yes

Same-origin, cookie-bearing calls to the site's own API plus shared-DOM reads cover a
large class of work with no synthetic input and no detection signal. It does not subsume
R-13: page JS state stays out of reach, and work that genuinely requires a trusted event
still requires one.
