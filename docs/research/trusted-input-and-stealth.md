# Trusted Input and Stealth for an MV3 Tab-Automation Extension

Research date: 2026-09-03. Verified against Chromium `main`, developer.chrome.com, WHATWG HTML, MDN.
Covers R-02 (low observability), R-13 (escalatable input fidelity), I-01, I-02.

## Answer first

1. `chrome.debugger` is still the only extension-reachable source of `isTrusted:true` input. Nothing else exists.
2. The banner cannot be suppressed from inside an extension. Only `--silent-debugger-extension-api` (browser-wide, all extensions) or force-install by enterprise policy suppress it — both are user/admin actions.
3. The banner is **global, per-extension, not per-tab**: one `GlobalConfirmInfoBar` shown in every window while any session is attached.
4. It does **not** vanish on detach; it auto-closes 5s after the last detach (`kAutoCloseDelay = base::Seconds(5)`), and never expires on navigation.
5. Attach-per-action is the *worst* pattern: re-attaching inside the 5s window silently reuses the bar, but outside it you re-animate a browser-wide infobar per action.
6. `attach()` sends **no** CDP commands. There is no automatic `Runtime.enable`, so the classic rebrowser leak is not triggered by attach itself — only by domains you enable. Use `Input` (+`DOM`) only.
7. `navigator.webdriver` is **unaffected** by `chrome.debugger` — it is set only by `--enable-automation`, `--headless`, `--remote-debugging-pipe`, `--remote-debugging-port=0`.
8. The strongest attach-time leak is the infobar itself: it shrinks the web-contents area, producing an observable `resize` / viewport-height change on every tab.
9. I-02: the hard gate is HTML's *activation triggering input event*, which requires `isTrusted === true`. That gates ~30 APIs — popups, fullscreen, clipboard, file/color pickers, PaymentRequest, screen capture, WebUSB/HID/Serial, PiP.
10. Recommendation: default content-script input; escalate to a **single session-scoped attach for a whole run segment**, never per-action; and treat the banner as a disclosed, user-visible mode, not something to hide.

---

## 1. chrome.debugger: current state, the infobar, the switch

### API surface
`chrome.debugger.attach(target, requiredVersion)`, `.detach(target)`, `.sendCommand(session, method, params)`, events `onEvent` / `onDetach`. Requires the `"debugger"` manifest permission. Chrome 125+ supports flat sessions via an optional `sessionId` on `sendCommand`. ([docs](https://developer.chrome.com/docs/extensions/reference/api/debugger))

Enterprise policy can block attach outright: `ExtensionSettings` `runtime_blocked_hosts` → `"Host access is restricted by policy."`; `DisableScreenshots`/DLP → `"Screenshot capture is restricted by policy."` ([docs](https://developer.chrome.com/docs/extensions/reference/api/debugger))

### The infobar — exact current behaviour (Chromium `main`)

`ExtensionDevToolsClientHost::Attach()`:

```cpp
const bool suppress_warning =
    base::CommandLine::ForCurrentProcess()->HasSwitch(
        ::switches::kSilentDebuggerExtensionAPI) ||
    Manifest::IsPolicyLocation(extension_->location());
if (!suppress_warning) { ... CreateWarningInfobar(); }
```
([debugger_api.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/debugger_api.cc))

Exact string: `"<Extension Name>" started debugging this browser` — `IDS_DEV_TOOLS_INFOBAR_LABEL` in [generated_resources.grd](https://source.chromium.org/chromium/chromium/src/+/main:chrome/app/generated_resources.grd). Note the string's own `desc` is **stale**: it claims the label never disappears; the code now auto-closes it.

From [extension_dev_tools_infobar_delegate.h](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.h) / [.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc):

- `static constexpr base::TimeDelta kAutoCloseDelay = base::Seconds(5);`
- `// infobar_ is set after attaching an extension and is deleted 5 seconds after detaching`
- `bool ShouldExpire(...) const override { return false; }` → **navigation does not dismiss it**.
- Shown via `GlobalConfirmInfoBar::Show()` — one bar, **all browser windows**, keyed by extension id in a static `Delegates` map.
- `Create()` on an existing delegate calls `it->second->timer_.Stop()` and reuses it → **re-attach inside the 5s window does not re-show or re-animate the bar.**
- `MaybeStartAutocloseTimer()` only starts when `callback_list_.empty()` → the bar persists while *any* session for that extension is live.
- Single button labelled Cancel (`IDS_APP_CANCEL`); pressing it destroys the delegate, notifies every registered client host, and detaches **all** of that extension's sessions with `DetachReason` `canceled_by_user`. The extension cannot intercept or veto it.

**Answer to "does the infobar persist after detach": yes, for 5 seconds, browser-wide.**

### `--silent-debugger-extension-api`
Still present. `chrome/common/chrome_switches.cc`: *"Does not show an infobar when an extension attaches to a page using chrome.debugger page. Required to attach to extension background pages."* ([chrome_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/chrome_switches.cc), [chrome-flags-for-tools](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)). It is browser-wide and applies to **every** installed extension for that launch — a real security downgrade. The `chrome://flags` entry was removed after Chrome 79; only the command line works, and Chrome must be fully closed first ([SO](https://stackoverflow.com/questions/74458077/silent-debugger-extension-api-flag-not-working-as-expected)).

### Policy suppression
`Manifest::IsPolicyLocation()` — i.e. `ExtensionInstallForcelist` — bypasses the bar entirely, "no visible indication at all." Comment cites `crbug.com/41302695` (ex-693621). Documented by [UiPath](https://docs.uipath.com/studio-web/automation-cloud/latest/user-guide/debugging-banner-notification-after-extension-upgrade-to-manifest-v3) and [Microsoft's amplifier-browser-bridge](https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/DEBUGGER_BANNER.md), which deliberately declines to use either mechanism.

### Quiet-mode bug status
- [crbug.com/1096262](https://crbug.com/1096262) — the bug that produced the current 5s-autoclose + state-synced behaviour. Landed; this is the fix, not a pending quiet mode.
- [issues.chromium.org/40245707](https://issues.chromium.org/issues/40245707) — "Usability issue with the 'plugin is debugging this tab' infobar", still open; requires sign-in to read comments, so status is **unverified**.
- [anthropics/claude-code#69287](https://github.com/anthropics/claude-code/issues/69287) — Claude in Chrome hits exactly this; the only workarounds offered are the switch and the forcelist policy. **No Chrome-side opt-in quiet mode exists as of 2026-09.**

### Timing cost of attach + dispatch + detach
**No primary measurement found.** Microsoft's bridge reports a 20s idle soft-detach plus Chromium's ~5s bar clearance ≈ 25s visible window per burst ([DEBUGGER_BANNER.md](https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/DEBUGGER_BANNER.md)). Treat attach latency as unknown and measure it in-repo before designing around it. Known qualitative cost: attach fails with `"Another debugger is already attached"` if DevTools is open on the tab, and cross-origin navigation detaches the session, requiring re-attach ([openclaw#29806](https://github.com/openclaw/openclaw/issues/29806)).

---

## 2. What the page can detect while chrome.debugger is attached

### Does attach auto-enable Runtime? No.
`Attach()` calls `agent_host_->AttachClient(this)` and nothing else — no CDP command is issued ([debugger_api.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/debugger_api.cc)). Chrome's own docs show `Runtime.enable` as something *you* send ([docs](https://developer.chrome.com/docs/extensions/reference/api/debugger)). So the classic leak is opt-in.

### The classic Runtime.enable leak
`Runtime.enable` makes the browser emit `Runtime.consoleAPICalled`, whose DevTools-preview serialization touched a planted `error.stack` getter — 5 lines of page JS, detected default Puppeteer/Playwright regardless of stealth plugins. Rebrowser reproduced live blocking on Cloudflare Turnstile- and DataDome-protected sites: with `Runtime.enable` the CAPTCHA appeared instantly; disabling it made the challenge disappear under otherwise identical conditions ([rebrowser](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)).

**Important 2026 update:** a Chrome change during 2025 altered that serialization path and the getter stopped firing; detectors keying on it went dark, silently. Newer probes target other serialization paths, `console` timing, and debugger-pause behaviour ([Foil, 2026-06](https://usefoil.com/learn/cdp-detection)). Foil is a vendor source — treat the specifics as directional, the principle (any attach-visible behaviour change is a probe) as sound.

**Conclusion for R-02: attaching with only `Input` (and `DOM` for geometry) avoids this entire family.** Never enable `Runtime`, `Debugger`, `Profiler`, `Console`, or `Log` on a page you care about.

### navigator.webdriver
Unchanged by `chrome.debugger`. `EnableAutomationControlled` is bound only to `--enable-automation`, `--headless`, `--remote-debugging-pipe`, and `--remote-debugging-port=0` (specifically 0):

```cpp
{wrf::EnableAutomationControlled, switches::kEnableAutomation, true},
{wrf::EnableAutomationControlled, switches::kHeadless, true},
{wrf::EnableAutomationControlled, switches::kRemoteDebuggingPipe, true},
```
([content/child/runtime_features.cc L374-379 + L420-435](https://source.chromium.org/chromium/chromium/src/+/main:content/child/runtime_features.cc)). This is the core structural advantage of the extension route over Puppeteer/Playwright: no flag, no `webdriver`, no emptied `chrome.runtime`, real user profile.

### Do Cloudflare / DataDome / PerimeterX detect `chrome.debugger` attachment specifically?
**No direct evidence found.** What exists:
- Evidence they detect **`Runtime.enable`** (rebrowser, above) — a command, not attachment.
- One anecdotal report that zhipin.com redirects to `about:blank` within ~100ms of `chrome.debugger.attach()`, attributed partly to the infobar's `visualViewport` reflow ([OpenCLI PR #1769](https://github.com/jackwener/OpenCLI/pull/1769)) — unverified single source.
- The infobar-shrinks-viewport mechanism is corroborated independently: the `--enable-automation` infobar demonstrably changes rendered viewport dimensions ([lighthouse#12988](https://github.com/GoogleChrome/lighthouse/issues/12988)). A page can watch `window.innerHeight` / `visualViewport` for an unexplained shrink-then-restore.

**Treat "attach is silently detectable via the infobar's layout effect" as likely-true and design around it; treat "vendor X fingerprints chrome.debugger" as unproven.**

---

## 3. Alternatives to chrome.debugger for trusted input

| Mechanism | Trusted? | Status |
|---|---|---|
| `dispatchEvent` / `new MouseEvent` in content script | No | `isTrusted:false` by spec ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)) |
| `HTMLElement.click()` | No | Spec-explicit: sets `isTrusted` to `false` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)) |
| `chrome.scripting.executeScript` MAIN world | No | Confirmed by Chromium engineers on chromium-dev ([thread](https://groups.google.com/a/chromium.org/g/chromium-dev/c/94t2J_Jylyw)) |
| `chrome.userScripts` MAIN world | No | Same renderer path; no trust-granting mechanism exists |
| `chrome.automation` | Actions exist, but unusable | `getDesktop` is ChromeOS-only; `getTree` deprecated; Chromium calls it "effectively a private api" ([automation.idl](https://chromium.googlesource.com/chromium/src/+/9ddb2190fe84221506e9ada748bbea36f45b050d/chrome/common/extensions/api/automation.idl), [deprecation commit](https://github.com/chromium/chromium/commit/7c2d3f75d30b07da376eabe2754959fec472a8ef)) |
| `document.execCommand('copy')` | Partial | Works in a content script / offscreen doc with `clipboardWrite`; a targeted escape hatch for clipboard only, not general input. Use `chrome.offscreen` with `reasons:['CLIPBOARD']` ([offscreen docs](https://developer.chrome.com/docs/extensions/reference/api/offscreen)) |
| `chrome.debugger` + `Input.*` | **Yes** | The only one. Events enter as `WebInputEvent`, upstream of the renderer's trust decision ([CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)) |

**WECG / standards status:** no `chrome.input` and no "trusted events" proposal exists. The 2023 chromium-dev request was rejected on spec grounds — `isTrusted` is defined by *who* called dispatch, so granting it to content scripts requires a DOM spec change; the counter-proposal was "use `chrome.debugger` or `chrome.automation`" ([thread](https://groups.google.com/a/chromium.org/g/chromium-dev/c/94t2J_Jylyw)). WECG's [proposal process](https://github.com/w3c/webextensions/blob/main/proposals/proposal_process.md) requires a sponsoring vendor; none exists here. **Do not plan on this changing.**

---

## 4. What sites can detect about an extension in general

**Detection surfaces**
- **`web_accessible_resources` probing** — the classic. A site fetches `chrome-extension://<id>/<path>`; success proves install. Mitigate with `use_dynamic_url: true` (id regenerated per session/reload) and always scope `matches` narrowly. By default nothing is web-accessible precisely because it "allows a malicious website to fingerprint extensions." ([docs](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources))
- **DOM mutations** — injected nodes, attributes, stylesheets are visible to `MutationObserver` from page JS.
- **Injected globals** — anything set on `window` in the MAIN world. Enumerating own-properties of `window`/`document`/prototypes for unknown names is a live technique ([Foil](https://usefoil.com/learn/cdp-detection)).
- **`isTrusted` on click/keydown/submit** — one boolean, free to check.
- **Event completeness** — a bare `click` with no `pointerdown`/`mousedown`/`focus`/`pointerup`/`mouseup` before it.
- **Pointer telemetry** — `movementX/Y` deltas that disagree with the coordinate stream; `pressure`/`tangentialPressure`/`tiltX/Y`/`twist` left at defaults; `pointerId` reuse; `getCoalescedEvents()` returning only the event itself, where a real 120 Hz mouse yields a fan of samples. CDP does not synthesize coalesced samples ([crawlex](https://blog.crawlex.net/blog/synthesizing-human-input-events/)).
- **Trajectory** — straight lines, uniform time deltas (Puppeteer/Playwright's fixed 10-step move is named "the staircase" in anti-bot literature), zero-duration press→release.
- **Timing** — inhumanly regular inter-action gaps; reaction times below human floor.
- **Mixed trust** — `Input.insertText` fires no `keydown`/`keyup`, so extensions often bolt on synthetic `KeyboardEvent`s; a handler checking `isTrusted` per event then sees trusted and untrusted events in one logical keystroke, which no real keyboard produces ([crawlex](https://blog.crawlex.net/blog/synthesizing-human-input-events/)).
- **Viewport shrink** — the debugger infobar (see §2).

**Hygiene rules for the content-script agent**
1. No MAIN-world globals. Stay in the isolated world; use `chrome.runtime` messaging, never `window.postMessage` on shared channels or custom DOM events.
2. Declare zero `web_accessible_resources`. If any are unavoidable, set `use_dynamic_url: true` and narrow `matches` to the exact origins.
3. No persistent injected DOM on the automated page. Put agent UI in a side panel / popup / separate extension page, not in the page DOM. If an overlay is unavoidable, mount it in a closed shadow root, keep it out of layout, and remove it before each action.
4. Fire full event cortèges: `pointerover`→`pointerenter`→`pointermove`→`pointerdown`→`mousedown`→`focus`→`pointerup`→`mouseup`→`click`, in spec order.
5. Populate pointer fields realistically: distinct `pointerId`, `pointerType:'mouse'`, `pressure` 0.5 while down / 0 while up, `isPrimary:true`, `buttons` consistent across the sequence, `movementX/Y` matching the coordinate delta.
6. Move before you click. Curved path, bell-shaped velocity, log-normal timing, non-zero press duration (~45ms median).
7. Never dispatch at (0,0) or at an element's top-left; use a jittered point inside the visible box, and verify with `document.elementFromPoint`.
8. Randomize inter-action delays with a heavy-tailed distribution; add occasional overshoot/correction and idle gaps.
9. Never mix trusted and untrusted events inside one logical interaction. Pick a lane per action.
10. Do not read the page via `Runtime.evaluate` when attached — use `DOM.*` or the content script.
11. Avoid detectable prototype patching (`toString()` on a patched function is checkable, and cross-origin iframes and workers see the unpatched original).
12. Scroll with `behavior:'instant'` and re-read geometry after; smooth scrolling makes coordinates stale mid-flight.

---

## 5. I-02: where `isTrusted:false` actually fails

The single normative gate: HTML defines an **activation triggering input event** as one *"whose `isTrusted` attribute is true"*, restricted to `keydown` (not Esc / UA shortcut), `mousedown`, `pointerdown` (`pointerType == "mouse"`), `pointerup` (`pointerType != "mouse"`), `touchend` ([HTML §user activation](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event)). No trusted event ⇒ no transient activation ⇒ ~30 APIs refuse.

**Requires transient activation** (fails with content-script input) — [MDN list](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation):
`Window.open()` (popups; also *consumes* activation, one per gesture) · `Element.requestFullscreen()` · `Element.requestPointerLock()` · `Clipboard.read/readText/write/writeText()` · `HTMLInputElement.showPicker()` / `HTMLSelectElement.showPicker()` · `Window.showOpenFilePicker/showSaveFilePicker/showDirectoryPicker()` · `PaymentRequest.show()` · `MediaDevices.getDisplayMedia()` · `Navigator.share()` · `USB/HID/Serial.requestDevice()` · `HTMLVideoElement.requestPictureInPicture()` · `DocumentPictureInPicture.requestWindow()` · `Document.requestStorageAccess()` · `Keyboard.lock()` · `EyeDropper.open()` · `Window.queryLocalFonts()` / `getScreenDetails()` · `XRSystem.requestSession()` · `PresentationRequest.start()` · `Clients.openWindow()` / `WindowClient.focus()`.

**Requires sticky activation:** media autoplay with sound, Web Audio `AudioContext` resume, `Navigator.vibrate()`, `beforeunload` ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation)). Sticky survives one real user interaction, so these often work if the user has clicked anywhere on the page first.

**File pickers specifically:** `input.click()` on `<input type=file>` from script logs *"File chooser dialog can only be shown with a user activation"* and silently does nothing; it works from the DevTools console only because DevTools emulates physical interaction. Chromium contributors state the only extension route is `chrome.debugger` + `Input` ([SO](https://stackoverflow.com/questions/66003975/click-on-input-type-file-not-opening-file-dialog), [SO](https://stackoverflow.com/questions/70847950/file-chooser-dialog-can-only-be-shown-with-a-user-activation)). `showPicker()` throws `NotAllowedError` without transient activation and `SecurityError` cross-origin except for file/color ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/showPicker), [whatwg/html#7319](https://github.com/whatwg/html/pull/7319)).

**Default actions:** since Chrome 53, untrusted events do not run default actions — so a synthetic event runs your handlers but will not submit a form or follow a link. `click` is the grandfathered exception, retaining activation behaviour even when untrusted ([crawlex, citing the 2016 Blink intent](https://blog.crawlex.net/blog/synthesizing-human-input-events/) — secondary source, worth re-verifying).

**Payment iframes, drag-and-drop, Google/Microsoft login:** no primary source found confirming a hard `isTrusted` gate. `PaymentRequest.show()` is confirmed activation-gated (above). HTML5 drag-and-drop from synthetic events is widely reported broken but I found no spec/Chromium citation — **unverified**. React/Vue handlers checking `e.isTrusted` are an application-level pattern, per-site, not enumerable.

**Practical escalation triggers for R-13:** file upload, clipboard, popup/new-window, fullscreen, payment, screen share, WebAuthn/device pickers, and any observed no-op where the DOM does not change after a click.

---

## 6. Recommendation

**Design: two modes, explicit, session-scoped.**

**Mode A — In-page (default).** Content script in the isolated world, full event cortège, humanized kinematics per §4. Zero banner, zero attach, zero CDP surface. Handles the large majority of interactions.

**Mode B — Trusted (escalated).** One `chrome.debugger.attach` per *run segment*, holding the session for the duration, `Input` + `DOM` domains only, then detach.

**Why session-scoped and not per-action:**
- The bar is browser-wide and per-extension, not per-tab; the cost is paid once per attach regardless of how many actions follow ([infobar delegate source](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc)).
- Re-attaching >5s after detach recreates and re-animates the bar in every window; per-action attach turns one steady bar into a strobe. Within 5s, `timer_.Stop()` reuses the existing bar — so the *only* per-action pattern that is not worse is one where actions are <5s apart, which is exactly a held session with extra failure modes.
- Every attach/detach is an infobar show/hide, i.e. a viewport-height change the page can observe (§2). Per-action attach maximizes that signal; one attach minimizes it.
- Attach fails outright if DevTools is open, and cross-origin navigation drops the session — fewer attach points means fewer failure points.

**Non-negotiables for Mode B:**
- Enable **only** `Input` (+`DOM` for geometry). Never `Runtime`/`Debugger`/`Console`/`Log`/`Profiler` on a target page.
- Register `chrome.debugger.onDetach`; treat `canceled_by_user` as a real user stop signal — abort the run, never silently re-attach. The Cancel button is the user's kill switch and must stay effective.
- Do not use `Input.insertText` alongside synthetic `KeyboardEvent`s; pick `Input.dispatchKeyEvent` (`rawKeyDown`/`char`/`keyUp`) when key handlers matter.
- Surface the mode in the extension's own UI so the banner is explained rather than surprising.

**On suppressing the banner: don't.** Neither mechanism is available to the extension. `--silent-debugger-extension-api` disables the warning for *every* installed extension for that launch, and force-install gives "no visible indication at all." Both are user/admin decisions with real security cost. Document them in a FAQ if power users ask; never ship a launcher that sets them, and never make the product depend on them.

**On R-02 vs R-13:** they are genuinely in tension and the tension is not resolvable by cleverness. The honest framing: Mode A is low-observability, Mode B is high-capability and *visibly disclosed*. Keep the escalation explicit and user-visible (a toggle or per-action prompt) — which R-13 already specifies, and which is also the only posture consistent with Chrome Web Store review for the `debugger` permission.

---

## Risks / still unknown

- **Attach latency unmeasured.** No primary source. Measure `attach → Input.dispatchMouseEvent → detach` wall time in-repo before any latency-sensitive design.
- **Infobar layout effect unquantified.** The mechanism is corroborated ([lighthouse#12988](https://github.com/GoogleChrome/lighthouse/issues/12988)) but I found no direct measurement of the `resize`/`visualViewport` event a page sees on attach. Test it: attach and log `window.innerHeight` before/after.
- **crbug 40245707 status unread** — issues.chromium.org requires sign-in. Check whether a quiet mode is planned.
- **Post-2025 CDP probes unmapped.** Foil (vendor) says the classic `Runtime.enable` leak went dark and new probes replaced it, without naming them. Assume unknown attach-visible probes exist.
- **Anti-bot vendors detecting attach specifically: unproven.** Only one anecdotal report (zhipin.com / OpenCLI PR). Do not design around it as fact, but do assume the infobar is observable.
- **Drag-and-drop and payment-iframe trust gates: unverified.** No primary source located. Verify empirically per target site.
- **Chrome could change any of this.** `kAutoCloseDelay`, the global-vs-per-tab bar, and the policy bypass are all implementation details in `chrome/browser/extensions/api/debugger/`, not documented API. Re-check the source on major Chrome upgrades.
- **Store review risk.** The `debugger` permission draws extra scrutiny and requires justification in the privacy declaration; a rejection would invalidate Mode B entirely.
