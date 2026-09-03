# Bot detection: what a site can actually observe, and what defeats it

Research date **2026-09-03**. Chrome Stable is **152.0.7977.82** (verified via
[versionhistory API](https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions)).
Baseline under evaluation: MV3 extension in the user's real Chrome, real profile/cookies/fingerprint, no
automation flags, driving pages from an **isolated-world content script with synthetic DOM events**, optionally
escalating to `chrome.debugger` **Input** domain. Companion doc: `trusted-input-and-stealth.md` (escalation
mechanics); this doc is the detection-side view.

Evidence tags: **[V]** vendor doc/patent/blog · **[R]** named reverse-engineering · **[A]** academic/measurement ·
**[S]** spec/Chromium source · **[?]** low-confidence secondary · **[inf]** my inference.

## Answer first

1. Every **network-layer** fingerprint (TLS JA3/JA4, HTTP/2 SETTINGS + pseudo-header order, HTTP/3, header order,
   Client Hints) is *perfect* for the baseline — it is the real Chrome network stack. This is the single biggest
   structural advantage over Puppeteer/Playwright/Camoufox and it is free.
2. Every **device-fingerprint consistency** check (UA vs platform vs WebGL vs fonts vs timezone vs Client Hints)
   is also perfect, for the same reason. Detectors that score "impossible combos" score us as a real human.
3. Every **automation-artifact** check in every detector I read — `navigator.webdriver`, `cdc_*`, `__pwInitScripts`,
   `Runtime.enable` leak, `pptr:`/`UtilityScript` stack markers, headless PDF viewer, 800×600 viewport — is
   **negative** for the baseline. BotD, CreepJS's headless/stealth modules and fpscanner's whole `detections/`
   directory fire on none of it.
4. The **isolated world is explicitly considered safe** by the strongest automation detector: rebrowser's own test
   says content running in an isolated world "is safe and not detectable" (`index.js:349`).
5. So the baseline's exposure is **almost entirely behavioural and side-channel**, not fingerprint. Five leaks matter.
6. **`isTrusted:false` is the fatal one.** brotector scores it 1.0 outright (`brotector.js:341`). It cannot be
   forged from an extension by any means — Camoufox needed a *browser patch* to fix it.
7. **`navigator.userActivation.isActive === false` at click time** is the cheaper, equally-lethal sibling. Spec-defined,
   one property read, no event listener required.
8. **`getCoalescedEvents().length === 0` on `pointermove`**, and the total absence of `pointerrawupdate`, are
   spec-guaranteed differences between real and constructed pointer events.
9. **Long-task / LoAF side channel**: our DOM-snapshot pass blocks the main thread; the page sees a ≥50 ms frame with
   `scripts: []`. Extension work is *deliberately* unattributed but its *duration* is exposed. Nothing closes this
   except making the work cheap.
10. **`chrome.debugger` escalation got much cheaper in the last year.** crbug#1477537 (CDP `screenX==clientX`) was
    **fixed and merged 2025-09-15** (CL 6917162, "Fix screen coordinates to avoid automation detection"), landing
    ~M142; CDP Input now also emits coalesced events. The 2024-era literature on this is stale.
11. What `chrome.debugger` still costs: the **global infobar** on every tab, which shrinks `innerHeight` — an
    unexplained viewport shrink/restore correlated with the agent acting is observable and not suppressible
    without `--silent-debugger-extension-api` or policy install.
12. **Verdict: not fatal, conditionally.** Synthetic-events-only is fatal against any site that checks `isTrusted`
    or `userActivation`. Debugger-Input escalation closes all five top leaks at the cost of one visible infobar.
    Design for escalation-by-default on sites that matter, not escalation-as-fallback.

---

## Part A — what detection vendors measure (2024-2026)

### A.0 Cross-cutting: the CDP `Runtime.enable` leak and its 2025 death

The probe: with `Runtime.enable` sent, `Runtime.consoleAPICalled` made V8's inspector build an object *preview* of
console arguments, and building it read `.stack`/`.name`, invoking a page-planted getter. `console.debug(errWithStackGetter)`
→ getter fires → CDP attached. Published by DataDome 2024-06-13 **[V]**
(<https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/>).

**Killed by two V8 commits, 7 and 9 May 2025** ("Avoid error side effects in DevTools"; "Apply getter guard throughout
error preview"), adding `getErrorProperty()` in `src/inspector/value-mirror.cc`, which skips any getter whose
`ScriptId() != kNoScriptId`, i.e. user code. Chromium issue 40073683. Documented by Castle 2025-08-28 **[R]**
(<https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/>).
No source names the exact milestone — treat "Chrome 138" as **[inf]**, unverified.

The *class* is not dead. A post-patch bypass reaches the getter via the prototype chain (Path B in
`buildObjectPreviewInternal`), and `console.groupEnd(obj)` with a Proxy *prototype* still fires the `ownKeys` trap;
reported reachable in early-2026 Chrome **[R]** (<https://svebaa.github.io/personal/blog/cdp-fingerprinting/>).
DataDome's own 2026-06-01 post concedes the trick died **[V]**
(<https://datadome.co/threat-research/how-browser-vendors-are-quietly-making-automation-harder-to-detect/>).

**Applies to baseline?** Only if we ever send `Runtime.enable`/`Console.enable`. `chrome.debugger.attach()` sends no
CDP command by itself (`Attach()` calls `AttachClient()` and nothing else,
[debugger_api.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/extensions/api/debugger/debugger_api.cc)) **[S]**.
Never enable `Runtime`, `Console`, `Log`, `Debugger`, `Profiler` on a page we care about.

### A.1 Cloudflare (Bot Management, Turnstile, Precursor)

- **JA3 and JA4 are first-class documented fields** (`cf.bot_management.ja3_hash`, `.ja4`), Enterprise-only, null on
  TLS resumption **[V]** <https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/>.
- **JA4 Signals**: per-JA4 hourly global aggregates exposed to customers — `browser_ratio_1h`, `h2h3_ratio_1h`,
  `uas_rank_1h`, `ips_quantile_1h`, etc. Cloudflare sees >15M unique JA4s/day **[V]**
  <https://blog.cloudflare.com/ja4-signals/>. The same post names the stack explicitly: **HTTP Signature**
  (headers + attributes, used "to detect inconsistencies between the HTTP signature and the claimed user-agent"),
  ClientHello fingerprint v1/v2, and an **HTTP/2 fingerprint** from "the settings frame, stream priority
  information, and the order of pseudo-header fields."
- Still actively used: since June 2025, 50 hand-written heuristics using "HTTP/2 fingerprints and Client Hello
  extensions" **[V]** <https://blog.cloudflare.com/per-customer-bot-defenses/>.
- **Header order** is a documented detection ID **[V]**
  <https://developers.cloudflare.com/bots/additional-configurations/detection-ids/>.
- **Turnstile really does proof-of-work.** Current docs (updated 2026-08-14): challenges "include proof-of-work
  (computational puzzles), proof-of-space, probing for web APIs, and various other challenges for detecting
  browser-quirks and human behavior" **[V]** <https://developers.cloudflare.com/turnstile/>. Difficulty is adaptive.
  Every *specific* number circulating (SHA-256, "~20 bits", "5-10 s headless") traces only to content farms **[?]**.
- **JavaScript Detections (JSD)** is separate and runs on every HTML page view, 15-min lifespan, result in
  `cf_clearance` → `cf.bot_management.js_detection.passed` **[V]**
  <https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/>.
- **Precursor (2026-07-13) is the important 2026 change** **[V]**
  <https://blog.cloudflare.com/introducing-precursor/>. Session-scoped continuous behavioural collection, script
  **injected into HTML at the edge**, "compact, obfuscated, and assembled dynamically for each response."
  Collects pointer movement, keyboard activity, focus changes, page visibility. Edge evaluators **cross-reference
  streams** — "pointer activity correlates with page visibility duration," "keyboard events only fire when a text
  field is focused." Explicit human-motion model: wrist-pivot arcs, cognitive-load delay before click, hand tremor
  vs bots' "linear interpolations or mathematically ideal Bézier curves." Session-scoped: "a bot cannot reset its
  behavioral signature by refreshing the page." **This is the vendor statement that most directly threatens our
  humanizer design, and it names Bézier curves as the tell.**
- Independent instrumentation **[A]**: Cloudflare's scripts probe ~13 window-level automation honeypots and cover
  all eight fingerprinting categories in one execution; Turnstile is the 6th most-deployed third-party script on
  the Tranco 10K (794 sites) — <https://arxiv.org/html/2606.14525v1>.

### A.2 DataDome

- TLS fingerprinting confirmed with a worked UA-mismatch case **[V]**
  <https://datadome.co/engineering/how-tls-fingerprinting-reinforces-datadomes-protection/>. JA4 by name is *not*
  confirmed on datadome.co.
- Docs list "Inconsistent HTTP headers" as a detection model, plus datacenter/residential/free-proxy reputation **[V]**
  <https://docs.datadome.co/docs/threat-detection>. The JS tag collects "mouse movements or key strokes… OS,
  browser, GPU" and names **puppeteer-extra-stealth** as detected **[V]**
  <https://docs.datadome.co/docs/javascript-tag>.
- **Picasso** (canvas/GPU device-class fingerprint) is their published consistency mechanism **[V]**
  <https://datadome.co/threat-research/the-art-of-bot-detection-picasso-for-device-class-fingerprinting/>.
- **Proof of Browser**, launched **2026-06-17**: a PoW forcing combined WebGL + CSS-layout + DOM-mutation
  computation inside VM obfuscation, regenerated per build **[V]**
  <https://datadome.co/threat-research/how-datadome-blocked-14-million-bypass-attempts-with-proof-of-browser/>.
- Client obfuscation: 2026 repos show embedded WASM for signal hashing and, from ~Jan 2026, a **custom bytecode VM
  with encrypted opcode strings** **[R]** <https://github.com/manjustice/datadome-vm-internals>.
- Notably, DataDome itself published (2025-12) that browser anti-fingerprinting is degrading this signal class and
  it is **shifting weight to behavioural and server-side** **[V]**
  <https://datadome.co/threat-research/end-of-fingerprinting-how-browser-privacy-reshaping-bot-detection/>.
  Adversarial evaluation puts a 52.93 % evasion rate against DataDome from fingerprint inconsistency alone **[A]**
  <https://arxiv.org/html/2406.07647v3>.
- Caveat: Antoine Vastel wrote most of DataDome's public technical material and **left for Castle in late 2024** —
  he now maintains fpscanner (Part C).

### A.3 Akamai Bot Manager

- **Akamai originated the HTTP/2 fingerprint format**: Shuster, "Passive Fingerprinting of HTTP/2 Clients",
  Black Hat EU 2017, from 10M+ connections **[V]**
  <https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf>.
  Format `SETTINGS[;]|WINDOW_UPDATE|PRIORITY[,]|pseudo-header-order`. The canonical example string and the
  per-browser pseudo-header orders (Chrome `m,a,s,p`) are **third-party reconstructions** **[?]**.
- JA4 is a live product surface: Terraform `akamai_appsec_advanced_settings_ja4_fingerprint` **[V]**
  <https://techdocs.akamai.com/terraform/docs/as-ds-ja4-fingerprint>. Header-order/UA-mismatch detection is
  documented **[V]** <https://techdocs.akamai.com/cloud-security/docs/detection-methods>.
- The best vendor source on the JS sensor is the **patent** US20220329622A1 / US12101350B2: JS collects a
  fingerprint (screen, fonts, plugins) plus **telemetry** (mouse, keystroke, touch, gyroscope), autoposted async,
  scored server-side under `bm_sz`/`_abck` **[V]** <https://patents.google.com/patent/US20220329622A1/en>.
  US12652331 (2026) covers **Dynamic Signal Control** — varying *which* signals are collected per request
  specifically to defeat spoofing.
- Product page: scores 0-100 "starting with the very first request" from "mouse movements and keyboard strokes…
  or gyroscope and accelerometer", and detects **replay of previously validated telemetry** **[V]**
  <https://www.akamai.com/products/bot-manager>. Behavioural detection is **Premier-tier only** **[V]**.
- Sensor internals (58-element encrypted array, v3 envelope, stack-based mini-VM) are community RE only **[R]**
  <https://github.com/Myronfr/akamai-v3-sensor-analysis>.

### A.4 Kasada

- Client is a **custom bytecode interpreter** — control-flow flattening, Fisher-Yates-shuffled opcode dispatch,
  encoded string pools. Confirmed by three independent disassemblies **[R]**
  <https://github.com/umasii/ips-disassembler>. Kasada confirms only *rotation*: "obfuscation is applied to our
  scripts each time they load, generating unique polymorphic code" **[V]**
  <https://www.kasada.io/blog/bot-detection-do-you-see-what-i-see>.
  **Caveat:** the bytecode-VM patents that read like Kasada's architecture (US10382482B2 et al.) are assigned to
  **Shape Security / F5**, a competitor — not Kasada.
- **PoW confirmed by Kasada's own patent** US10855661 "Dynamic Cryptographic Polymorphism" (2020): server sends a
  hash + seed, browser brute-forces a matching value. Observed parameters (SHA-256, difficulty 10, `x-kpsdk-fc`)
  are RE **[R]** <https://github.com/1Maze/kasada-vm>.
- Explicitly targets DevTools and antidetect browsers **[V]**
  <https://www.kasada.io/blog/automation-frameworks-devtools-antidetect-browsers>.
- Positions *away* from fingerprinting toward "client interrogation" (evidence of automation, not identity) **[V]**,
  but still lists biometric validation (accelerometer, swipe, mouse) as a secondary ML layer **[V]**
  <https://www.kasada.io/bot-detection/advanced-bot-detection-techniques/>.
- Network-layer scoring by Kasada is asserted only by proxy-seller blogs **[?]** — no primary source.

### A.5 Extension detection — the honest answer

**None of Cloudflare, DataDome, Akamai or Kasada publicly claims extension detection.** Every attribution I found
is single-source and uncorroborated **[?]**. What *is* documented:

- The `web_accessible_resources` probe is real and exact: `fetch('chrome-extension://<id>/<declared path>')`
  resolves iff installed. Chrome's own docs name fingerprinting as the reason resources are non-accessible by
  default, and `use_dynamic_url: true` (Chrome 130+, 2024-10) regenerates the ID per session **[V]**
  <https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources>.
- A named vendor that *does* say it detects extensions is **Castle**, and it explicitly says it uses **DOM/JS side
  effects rather than `chrome-extension://` probing**, because probing produces console noise, failed requests and
  perf spikes that expose the detector **[V]**, 2026-01-14
  <https://blog.castle.io/detecting-browser-extensions-for-bot-detection-lessons-from-linkedin-and-castle/>.
- The production example at scale is **LinkedIn**, not an anti-bot vendor: ~6,167 probed extension IDs via
  `Promise.allSettled`, plus a TreeWalker "Spectroscopy" pass scanning the live DOM for `chrome-extension://`
  prefixes, inside a 48-signal pipeline **[R]** <https://leestack.dev/writing/linkedin-aed-systems-analysis>.

**Implication:** the mechanisms that would catch us are (a) DOM/CSS side effects and (b) behaviour — not resource
probing, which we defeat trivially by declaring zero `web_accessible_resources`.

### A.6 Prevalence in the wild [A]

Gundelach, Mühlhauser & Herrmann (U. Bamberg, 2026-06-12), 10 K Tranco sites × 4 browser configs —
<https://arxiv.org/html/2606.14525v1>: `navigator.webdriver` is probed on **34 %** of 7,944 sites, the single most
common check. Automation-family probe rates: WebDriver API 43 %, PhantomJS 32 %, NightmareJS 31 %, Selenium 28 %,
**Chrome DevTools 21 %**, ChromeDriver 8 %. 46 % of sites probe ≥1 automation-only signal. Cloudflare block rate
37 %, Akamai 26 %. **75 % of headless-only blocks were fixed by header spoofing alone.** The mass market is still
checking artifacts we do not have.

---

## Part C — open-source detector code, evaluated against three modes

Commits pinned: creepjs `10aa672` (2026-06-11), brotector `98b3309` (2024-12-03), rebrowser-bot-detector `e1a25b1`
(2024-10-25), BotD `66da86e` (2026-06-17), fpscanner `4255cfd` (2026-08-05, Vastel/Castle, full rewrite).
Local clones under `…/scratchpad/repos/`.

Modes: **(1)** content script + synthetic DOM events, no debugger. **(2)** same + `chrome.debugger` with only the
`Input` domain enabled. **(3)** OS-level injected input (uinput/libei), no in-browser automation.

| Detector · file:line | Check | (1) CS synthetic | (2) debugger Input | (3) OS input |
|---|---|---|---|---|
| brotector `brotector.js:341` | `e.isTrusted === false` → **score 1.0** | **FIRES** | no | no |
| brotector `brotector.js:319-350` | `pageX==screenX && pageY==screenY` (crbug#1477537) | no (we set screenX ourselves) | **no — fixed M142+**, was FIRES | no |
| brotector `brotector.js:352-368` | canvas cursor visualiser: `arc()` at mouse pos on a full-page `pointer-events:none` fixed canvas | fires **only if we draw an overlay** | same | same |
| brotector `brotector.js:218-278` | `Runtime.enable`/`Console.enable` via `console.debug` + `stack` getter + worker `debugger;` timing | no | no (never enable Runtime) | no |
| brotector `:182,198,207,279,288` | `navigator.webdriver`, `cdc_*`, `__pwInitScripts`, empty `getHighEntropyValues`, headless PDF-viewer `<style>` | no | no | no |
| brotector `brotector.js:171-181,371-388` | `Error.stack` regexes for `__puppeteer_evaluation_script__`, `pptr:`, chromedriver source strings | no | no | no |
| rebrowser `index.js:349-369` | `testMainWorldExecution` — hooks `document.getElementsByClassName` in MAIN world | **no** — isolated world; test's own text calls this "safe and not detectable" | no | no |
| rebrowser `index.js:371-411` | `testSourceUrl` — `pptr:` / `UtilityScript.` in `Error.stack` | no | no | no |
| rebrowser `index.js:4-19` | `window.dummyFn` reachable from MAIN world | no | no | no |
| rebrowser `index.js:21-62,64-140,142-169` | `runtimeEnableLeak`, `exposeFunctionLeak`, `__pwInitScripts` | no | no | no |
| rebrowser `index.js:171-202` | `navigator.webdriver` + `Object.getOwnPropertyNames(navigator)` must be `[]` | no | no | no |
| rebrowser `index.js:204-233,328-347` | default 800×600 / 1280×720 viewport; `Page.setBypassCSP` | no | no | no |
| BotD `src/sources/distinctive_properties.ts` | ~40 window/document markers (`_phantom`, `$cdc_…`, `domAutomation`, …) | no | no | no |
| BotD `src/detectors/{webdriver,window_size,product_sub,eval_length,function_bind,error_trace}.ts` | legacy headless/PhantomJS markers | no | no | no |
| BotD `src/detectors/document_element_keys.ts` | `documentElement.getAttributeNames()` contains `selenium`/`webdriver`/`driver` | no — **unless we set attributes on `<html>`** | no | no |
| CreepJS `src/headless/index.ts:97-110` | `webDriverIsOn`, `hasHeadlessUA` (also in worker) | no | no | no |
| CreepJS `src/headless/index.ts:111-155` | stealth-plugin tells: `hasIframeProxy`, `hasHighChromeIndex`, `hasBadChromeRuntime`, `hasToStringProxy`, `hasBadWebGL` (window vs worker GPU) | no — we patch no natives | no | no |
| CreepJS `src/lies/index.ts:123-330` | ~20 "lie" probes per native fn (`toString` identity, own-property descriptors, proxy/`setPrototypeOf` TypeErrors) | no | no | no |
| CreepJS `src/resistance/index.ts:134-475` | **extension identification purely by main-world lie-pattern hashes** (noscript, Trace, CyDec, CanvasBlocker, Chameleon, DuckDuckGo, Privacy Badger…) | **no** — an extension that patches no main-world native is invisible to this technique | no | n/a |
| fpscanner `src/signals/cdp.ts` | `Error.prepareStackTrace` set, then `console.log(err)`; flag flips if a CDP client serialises it | no | no (Runtime not enabled) | no |
| fpscanner `src/signals/browserExtensions.ts` | **known extensions by DOM side effect only**: `body[data-gr-ext-installed]`, `window.ethereum`, `#coupon-birds-drop-div`, `deepl-input-controller`, `#monica-content-root`, `chatgpt-sidebar`, `window.__REQUESTLY__`, `veepn-*` tags | **no if we inject no nodes/attributes/globals**; **FIRES** the moment we do | same | n/a |
| fpscanner `src/detections/hasContextMismatch.ts` | window vs iframe vs worker: webdriver/UA/platform/memory/cpuCount | no | no | no |
| fpscanner `src/detections/has{GPU,Platform}Mismatch,hasSwiftshaderRenderer,hasUTCTimezone,hasMismatchLanguages,hasInconsistentEtsl` | fingerprint-consistency family | no — real Chrome | no | no |
| sannysoft / fpscanner legacy | UA, WebDriver, `window.chrome`, permissions, plugins length, languages, WebGL vendor/renderer, broken-image dims | no | no | no |

**Reading of Part C.** Across five detectors and ~60 distinct checks, **exactly one fires against the baseline in
mode (1): `isTrusted`.** Two more become live only if we make ourselves visible: DOM overlays (canvas visualiser,
`browserExtensions`-style node/attribute probes) and any MAIN-world patching (CreepJS lies/resistance,
rebrowser mainWorldExecution). Mode (2) clears `isTrusted` and, since M142, also clears the coordinate leak.
Mode (3) is clean on every check in every file I read — *no detector in this set has any probe for OS-level
injected input.*

---

## Part D — countermeasures and evidence

### D.1 Leaks that CANNOT be closed from inside an extension

These justify escalation; nothing in the extension API surface can forge them.

| Leak | Why it cannot be closed | Source |
|---|---|---|
| `Event.isTrusted` | `[LegacyUnforgeable] readonly attribute boolean isTrusted` in the DOM IDL; set true only by the UA. Re-dispatching a trusted event makes it untrusted. Camoufox required a **Firefox source patch** (`patches/trusted-automation-events.patch`) to fix exactly this for `select_option`/`fill`/`set_input_files` — see `tests/patches/trusted-events.py` in the repo | [w3c/pointerevents#514](https://github.com/w3c/pointerevents/issues/514); local `repos/camoufox/tests/patches/trusted-events.py` |
| `navigator.userActivation.isActive` / transient activation | HTML defines an "activation triggering input event" as one *"whose `isTrusted` attribute is true"*. No trusted event ⇒ no transient activation, ever | <https://html.spec.whatwg.org/multipage/interaction.html#user-activation> |
| Default actions | Since Chrome 53 untrusted events run no default action — no form submit, no link follow, no native scroll from a synthetic `wheel`. `click` is the grandfathered exception | see `trusted-input-and-stealth.md` §5 |
| `pointerrawupdate` stream | Fired by the UA only, "as soon as possible and as frequently as the JavaScript can handle"; a real mouse produces a dense stream, synthetic input produces none unless we manufacture it (and then it is untrusted) | <https://w3c.github.io/pointerevents/#the-pointerrawupdate-event> |
| Long-task / LoAF duration from our own work | Extension script attribution is *deliberately* stripped, but the **frame duration is still reported** to the page. `scripts: []` on a 500 ms frame is itself the signature | [MDN LoAF](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing); worked example [w3c/long-animation-frames#10](https://github.com/w3c/long-animation-frames/issues/10) |

**Fakeable, contrary to folklore:** `PointerEvent.pressure`, `tiltX/tiltY`, `twist`, `tangentialPressure`,
`pointerId`, `pointerType`, `isPrimary`, `width/height`, `coalescedEvents`, `predictedEvents` are **all** settable
via `PointerEventInit`; `screenX/Y`, `movementX/Y`, `buttons`, `sourceCapabilities` via `MouseEventInit`/`UIEventInit`.
Defaults are the giveaway, not the fields: `pressure: 0`, `pointerId: 0`, `isPrimary: false`, `pointerType: ""`,
`coalescedEvents: []` (<https://w3c.github.io/pointerevents/#dom-pointereventinit>). A real mouse is
`pressure` 0 when no button and **0.5 when a button is down** ("For hardware and platforms that do not support
pressure, the value MUST be 0.5 when in the active buttons state and 0 otherwise"), `pointerId` 0 or 1,
`isPrimary: true`, `pointerType: "mouse"`. `event.timeStamp` is **not** settable — it is the construction time,
which is fine if we dispatch immediately.

### D.2 Countermeasures that do work

**Zero extension-fingerprint surface.** Declare no `web_accessible_resources` (closes the exact `chrome-extension://`
probe LinkedIn runs at 6,167-ID scale); declare no `externally_connectable` (closes `chrome.runtime.sendMessage`
probing); inject **no CSS** (closes the Laperdrix injected-stylesheet class); create **no DOM nodes and set no
attributes** on the page (closes the entire `fpscanner/src/signals/browserExtensions.ts` class — every one of its
eight probes is a node, attribute or global). If the agent needs a visual overlay, render it in the **side panel or
via CDP `Overlay`**, never in the page. Evidence that the alternative is caught: brotector's `canvasMouseVisualizer`
(`brotector.js:352-368`) exists specifically to catch cursor-visualiser overlays.

**Never touch the MAIN world.** Stay in the isolated world. This closes CreepJS `lies/` and `resistance/`
(which identifies extensions *only* by main-world patch signatures — `resistance/index.ts:134-475`) and rebrowser's
`testMainWorldExecution` (`index.js:349`, whose own note says isolated-world execution is "safe and not detectable").
`world: "MAIN"` in `chrome.scripting.executeScript` or `chrome.userScripts` throws this advantage away.

**`document_idle` vs `document_start`.** `document_start` is not directly observable from the page (isolated world),
but it maximises the window in which our snapshot work collides with the page's own critical path, which is exactly
what the LoAF channel exposes. `document_idle` costs us early-page control and risks missing SPA mount events.
**Recommendation: register at `document_start` but do no work until `requestIdleCallback`**, so the observable
(main-thread occupancy) is deferred even though injection is early.

**Cheap snapshots.** Never `querySelectorAll('*')` + `getBoundingClientRect()` per node in one pass — that is a
forced layout of the whole document and reliably a >50 ms frame. Chunk across `requestIdleCallback` with a
`timeRemaining()` budget; use `IntersectionObserver` for visibility instead of per-node rects; cache and invalidate
via a `MutationObserver` rather than re-walking. This is the only mitigation for the LoAF channel — it cannot be
closed, only made small.

**Humanized pointer trajectories — with a correction.** The two models actually shipped in this space:
- **WindMouse** (Benjamin J. Land): cursor as a mass under constant *gravity* toward the target plus a smoothly
  varying random *wind* force, with velocity clipped to a random magnitude in `[M₀/2, M₀]` and wind damped by √3
  near the target — which produces *emergent overshoot-and-correct*. Full algorithm and GPLv3 reference
  implementation: <https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/>.
- **Camoufox / HumanCursor**: cubic Bézier through 2 random knots ±80 px of the bounding box, Gaussian distortion,
  `easeOutQuad` tween, point count `min(150, max(2, length^0.25 · 20))` — `repos/camoufox/additions/camoucfg/MouseTrajectories.hpp:79-215`,
  ported from `riflosnake/HumanCursor` (`humancursor/utilities/human_curve_generator.py`).

  **Three flaws worth naming.** (a) The distortion is applied to **y only** — `distorted.push_back({x, y + delta})`,
  line ~172 — so the noise is axis-asymmetric, a trivially learnable artefact. (b) `easeOutQuad` gives a
  **monotonically decreasing** speed profile, whereas human ballistic movement is bell-shaped (accelerate, then
  decelerate) with discrete corrective submovements. (c) Cloudflare's Precursor post **names "mathematically ideal
  Bézier curves" as a bot signature** <https://blog.cloudflare.com/introducing-precursor/>. **Prefer WindMouse's
  force model, or minimum-jerk with explicit corrective submovements, over a Bézier.**

**Realistic event cortège.** For a click on an element not currently hovered, emit in order:
`pointerover → pointerenter → mouseover → mouseenter → (pointermove → mousemove)* → pointerdown → mousedown →
focus → pointerup → mouseup → click`, and `pointerout/pointerleave/mouseout/mouseleave` on exit. The spec does not
*mandate* the interleaving ("the relative order of some of these high-level events… is undefined and varies between
user agents", <https://w3c.github.io/pointerevents/#mapping-for-devices-that-support-hover>), so exact order is a
weak signal — but a **missing** `pointerover`/`mouseover` entirely is a strong one. Sample `mousemove` at
60–125 Hz (8–16 ms `timeStamp` deltas), set `movementX/Y` to the true per-step delta, set `screenX/Y` =
`clientX + window.screenX` (+ chrome offset) so `pageX != screenX`, set `pressure` 0.5 while `buttons != 0`,
`pointerId: 1`, `isPrimary: true`, `pointerType: "mouse"`, and populate `coalescedEvents` on `pointermove`
(a trusted `pointermove` **always** returns ≥1 coalesced event; an empty list is a tell —
<https://w3c.github.io/pointerevents/#dom-pointerevent-getcoalescedevents>).

**Typing.** Per-key latency drawn from a positively-skewed distribution (log-normal), digraph-dependent rather than
i.i.d., with occasional backspace-correction sequences and pauses at word/field boundaries; full
`keydown → keypress/beforeinput → input → keyup` per character rather than setting `.value`. Note Cloudflare's
Precursor cross-check: **"keyboard events only fire when a text field is focused"** — so never emit key events
without a real focus change first.

**Scrolling.** Real scroll is not reachable from synthetic `wheel` (no default action). From a content script the
honest option is `Element.scrollTo({behavior:'smooth'})` / `scrollBy`, which produces genuine `scroll` events and
real momentum, plus a synthetic `wheel` for handlers that listen for one. Under `chrome.debugger`,
`Input.dispatchMouseEvent{type:"mouseWheel"}` gives the real thing.

**Session cadence.** Precursor and Akamai both score at session level, and Precursor explicitly says refreshing
does not reset the signature. Throttle navigation to human intervals, keep dwell time proportional to page content,
avoid a navigation graph that is a perfect BFS/DFS, and do not act during `document.hidden`.

**`chrome.debugger` escalation — the current cost.** The infobar is created by `ExtensionDevToolsClientHost::Attach()`,
is a `GlobalConfirmInfoBar` shown **on every tab in every window**, does not expire on navigation
(`ShouldExpire()` returns false), and is removed **5 s after the last detach** (`kAutoCloseDelay`). It is suppressed
only by `--silent-debugger-extension-api` or `Manifest::IsPolicyLocation()` (policy-installed extensions)
— all read from Chromium source and corroborated across four independent reports
(<https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/DEBUGGER_BANNER.md>,
<https://stackoverflow.com/questions/78420135/>, <https://docs.uipath.com/studio-web/automation-cloud/latest/user-guide/debugging-banner-notification-after-extension-upgrade-to-manifest-v3>).
Google documents none of it. **The detection consequence** is the layout effect: an infobar shrinks the web-contents
area, so `window.innerHeight` drops and a `resize` fires at attach, restoring ~5 s after detach — an unexplained
shrink/restore correlated with agent activity. Corroborated for the `--enable-automation` infobar in
[lighthouse#12988](https://github.com/GoogleChrome/lighthouse/issues/12988); the `chrome.debugger` case is
**[inf]** by the same mechanism, not directly measured. Mitigation: attach **once** for a whole task rather than
per action (one shrink, not N), or accept the flag and keep the session short.

**What escalation buys, as of M142+.** crbug#1477537 — CDP `screenX == clientX` — was fixed by
[CL 6917162](https://chromium-review.googlesource.com/c/chromium/src/+/6917162), *"Fix screen coordinates to avoid
automation detection"*, **MERGED into `chromium/src` main 2025-09-15** (verified via the Gerrit REST API), landing
~M142; stable is now 152. CDP Input also now emits coalesced events. The maintainers of CDP-Patches — the tool
built to work around this — now say **"There is no reason to use this package anymore, except for Select Elements"**
(<https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches>). brotector's `Input.cordinatesLeak` check
(`brotector.js:319-350`, dated 2024-12) is therefore **stale against current Chrome**.

---

## Ranked leak table

| # | Leak | Who checks it | Applies to baseline? | Countermeasure | Residual risk |
|---|---|---|---|---|---|
| 1 | `Event.isTrusted === false` | brotector `brotector.js:341` (score 1.0); Cloudflare Precursor event-coherence evaluators **[V]**; app-level `e.isTrusted` guards | **YES, mode (1)** | **Cannot be fixed in-extension.** `chrome.debugger` `Input` domain, or OS-level input | None once escalated; escalation costs the infobar |
| 2 | No transient user activation at click (`navigator.userActivation.isActive`) | HTML spec makes it free to check; ~30 gated APIs fail visibly | **YES, mode (1)** | Same escalation. In mode (1), avoid every activation-gated flow | None once escalated |
| 3 | Behavioural: trajectory shape, timing, session coherence | Cloudflare **Precursor** (names Bézier curves) **[V]**; Akamai telemetry patent US12101350B2 **[V]**; DataDome slider **[V]**; Akamai telemetry-replay detection | **YES, all modes** | WindMouse-style force model (not Bézier), bell-shaped velocity + corrective submovements, isotropic noise, log-normal key latencies, focus-before-typing, human navigation cadence | **High and irreducible.** This is where a determined vendor wins; budget for detection here |
| 4 | LoAF / long-task with `scripts: []` | Any page, 5 lines of `PerformanceObserver`. Not known to be used by a vendor **[inf]** | **YES, all modes** | Chunk snapshots under `requestIdleCallback`, `IntersectionObserver` over per-node rects, MutationObserver-driven caching | Cannot be closed, only shrunk. Low current exploitation |
| 5 | DOM side effects from overlays / injected nodes, attributes, globals | fpscanner `signals/browserExtensions.ts`; brotector `canvasMouseVisualizer` `:352-368`; Castle **[V]**; LinkedIn Spectroscopy **[R]** | **Only if we render into the page** | Zero DOM writes; overlay in side panel or CDP `Overlay` | None if the rule holds; needs a lint/CI guard |
| 6 | `chrome.debugger` infobar → `innerHeight` shrink + `resize` | No vendor confirmed; mechanism corroborated **[inf]** | **Only mode (2)** | Attach once per task not per action; or `--silent-debugger-extension-api` / policy install (both change the user's security posture) | Moderate; unmeasured |
| 7 | Pointer realism: `pressure`, `pointerId`, `isPrimary`, empty `getCoalescedEvents()`, absent `pointerrawupdate`, `pageX==screenX` | brotector `:319-350`; CDP-Patches writeup **[R]** | **YES, mode (1)** if defaults are left alone | Set every `PointerEventInit`/`MouseEventInit` field explicitly; populate `coalescedEvents`; emit `pointerrawupdate` | Low — all fields are fakeable except trust |
| 8 | `web_accessible_resources` / `externally_connectable` probing | LinkedIn (6,167 IDs) **[R]**; Chrome docs acknowledge **[V]**; Sjösten/Karami lineage **[A]** | **NO** if we declare neither | Declare neither; `use_dynamic_url: true` if ever needed | None |
| 9 | Injected stylesheet fingerprinting | Laperdrix et al., "Fingerprinting in Style" **[A]** | **NO** if we inject no CSS | Inject no CSS | None |
| 10 | MAIN-world native patching signature | CreepJS `lies/index.ts`, `resistance/index.ts:134-475`; rebrowser `index.js:349` | **NO** — isolated world | Never use `world: "MAIN"` | None if the rule holds |
| 11 | `Runtime.enable` / `Console.enable` CDP serialisation leak | DataDome **[V]**, Castle **[R]**, rebrowser, brotector, fpscanner `signals/cdp.ts` | **NO** — attach sends no commands **[S]**; and largely patched May 2025 | Enable only `Input` (+ `DOM` for geometry) | None |
| 12 | `navigator.webdriver`, `cdc_*`, `__pwInitScripts`, headless UA/PDF/viewport, stack markers | 34 % of sites probe `webdriver` **[A]**; every detector in Part C | **NO** — real Chrome, no flags | Nothing needed. This is the baseline's structural win | None |
| 13 | TLS JA3/JA4, HTTP/2 SETTINGS + pseudo-header order, HTTP/3, header order, Client Hints | Cloudflare **[V]**, Akamai **[V]**, DataDome **[V]** | **NO** — real Chrome network stack | Nothing needed. Do not proxy through a non-Chrome HTTP client | None, provided no request is ever made outside the tab's own stack |
| 14 | Fingerprint-consistency (UA vs platform vs GPU vs fonts vs TZ vs CH, worker/iframe mismatch) | fpscanner `detections/*`, CreepJS, DataDome Picasso **[V]** | **NO** — genuinely consistent | Never spoof anything. Spoofing *creates* this leak | None |

---

## Recommendation

1. **Do not spoof anything.** The baseline's entire advantage is that rows 12-14 — the majority of what every vendor
   actually measures, and the only part they all document — are true. Every fingerprint override, UA string change
   or proxied fetch converts a passing check into a failing one.
2. **Treat `chrome.debugger` + `Input` as the default mode on protected sites, not the fallback.** It closes rows
   1, 2 and 7 completely, and since M142 it introduces no coordinate or coalesced-event artefact of its own. The
   remaining cost is one infobar, which is a *user-visible* cost, not a *detection* cost, except via the viewport
   shrink — mitigated by attaching once per task.
3. **Mode (1) is for unprotected sites only.** Synthetic events are fine for reading, for sites with no bot vendor,
   and for actions with no `isTrusted` guard — but any site running Cloudflare, DataDome, Akamai, Kasada or a
   home-grown `e.isTrusted` check sees mode (1) immediately and at zero cost to itself.
4. **Enforce three invariants in CI**: no `web_accessible_resources`, no `externally_connectable`, no
   `world: "MAIN"`, and no DOM writes to the page from the content script. Each is one grep; each closes a whole
   detector family (rows 5, 8, 9, 10).
5. **Budget real engineering for row 3 and row 4** — behaviour and main-thread occupancy. They are the two leaks
   that survive every architectural choice, and Cloudflare's Precursor (July 2026) is the vendor that has moved
   furthest toward exploiting the first.
6. **Do not build on a Bézier humanizer.** Cloudflare names it. Use WindMouse's force model or a minimum-jerk
   model with corrective submovements, and make the noise isotropic (Camoufox's is y-only).
7. **Re-verify quarterly.** Two of the most-cited facts in this space went stale within twelve months: the
   `Runtime.enable` leak (dead May 2025) and the CDP coordinate leak (dead September 2025). Assume the next one is
   already stale.

## Unverified

- **Which Chrome milestone** carried the May 2025 V8 error-preview fix. Commit dates only; "M138" is inference.
- **Whether the `chrome.debugger` infobar measurably changes `window.innerHeight`.** Mechanism is sound and the
  `--enable-automation` case is corroborated, but I did not measure the debugger case, and per instruction did not
  run anything against a live browser.
- **Whether any commercial vendor detects `chrome.debugger` attachment specifically.** No evidence found; all
  published evidence targets `Runtime.enable`, which is a *command*, not attachment.
- **Whether Akamai/Kasada/DataDome do extension detection.** Only single-source blog claims; not corroborated.
  Castle and LinkedIn are the only confirmed practitioners.
- **Turnstile PoW parameters**, Akamai `sensor_data` grammar, Kasada payload cipher — all reconstruction. A large,
  self-citing cluster of 2025-2026 SEO/AI-generated "anti-bot internals" posts asserts precise numbers with no
  primary basis; none of those numbers appear above.
- **Whether populating `coalescedEvents` on a synthetic `pointermove` is actually checked by anyone.** Spec-derived
  signal, no observed use.
- **Detectability of OS-level injected input (uinput/libei) from inside a browser.** No probe for it exists in any
  of the five detectors read, and I found no literature. Absence of evidence only.
