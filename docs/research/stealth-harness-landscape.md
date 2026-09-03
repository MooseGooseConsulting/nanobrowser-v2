# Stealth Harness Landscape

Research date: 2026-09-03. Scope: C-01 is open ("MV3, **or whatever extension harness gives the best
stealth**"), so every harness is on the table. Ranked against R-02 (low observability) first, then
R-01 (acts on the tab the user already has open) and R-05 (side panel is the primary surface).

Companion docs: `trusted-input-and-stealth.md` (chrome.debugger / CDP-Input mechanics, do not repeat
here), `live-testing-real-chrome.md`, `extension-stack.md`.

Local facts used below (read-only, this machine, 2026-09-03): `google-chrome 152.0.7977.75`,
`chromium 151.0.7922.173`, **no Firefox installed**, `hyprland 0.56.2`,
`xdg-desktop-portal-hyprland 1.4.1`, `libei 1.6.0`, `wtype 0.4`, no `ydotool`, no `xdotool`,
single monitor 1920x1200 @ `scale 1.5` (logical 1280x800).

## Answer first

1. **The harness is not where the detection is.** FP-Agent (UC Davis, arXiv:2605.01247, 2026-05-02)
   fingerprinted 7 agents incl. **Claude for Chrome — an MV3 extension in a real Chrome** — at
   **F1 = 0.9993 on behavioural features alone**, plateauing after ~1–3 minutes. Browser-fingerprint
   features alone scored only 0.7969. Cloudflare blocked 1 of the 7.
2. Which means: **input synthesis and action timing are the observable, not the harness.** Claude was
   caught for `change`-event form filling, paste-based typing, and sub-1ms inter-key latency.
3. **Staying in the user's real Chrome is the correct choice for R-02**, and it is not close. No flag,
   no `navigator.webdriver`, real Chrome TLS/JA3/JA4 + HTTP/2 + client hints, real profile, real
   residential IP, real history. Every alternative gives some of that back.
4. The extension's own exposure is real but *fixable by construction*: zero `web_accessible_resources`
   (or `use_dynamic_url: true`), zero MAIN-world globals, zero persistent DOM mutation. LinkedIn's
   production AED probes 6,167 extension IDs plus a `TreeWalker` DOM scan — both are defeated by
   declaring nothing and injecting nothing.
5. **Chrome's own answer confirms the shape.** Chrome 152 ships `chrome/browser/actor` +
   `chrome/renderer/actor` (`kGlicActor`, `kGlicActorUi`, both `FEATURE_ENABLED_BY_DEFAULT`), which
   dispatches `blink::WebMouseEvent` via `widget->HandleInputEvent()` — real trusted input, no CDP,
   no banner. It is gated to Glic, not extensions, and it is *deliberately conspicuous* (magic cursor,
   toast, tab indicator, border glow). Do not expect an extension trusted-input API.
6. **The biggest CDP-Input tell is already gone in the user's Chrome.** Chromium CL 6917162 ("Fix
   screen coordinates to avoid automation detection", merged 2025-09-15, bug 40280325) makes CDP
   Input events carry real `screenX/Y`. Vinyzu **archived CDP-Patches** on 2025-09-28 saying so.
7. **Camoufox is the strongest fingerprint work in public and still the wrong tool here.** It is
   Playwright-driven with its own profile; the user has no Firefox and would re-login everywhere
   (R-01 fails). Its humanised cursor lives in the Playwright side, so a sidebar add-on inside it
   would get the same `isTrusted:false` content-script input as Chrome — you pay the cost and lose
   the benefit.
8. **The single most important actionable finding is section 6.** Hyprland 0.56.2 implements
   `zwlr_virtual_pointer_manager_v1` and `zwp_virtual_keyboard_manager_v1`. A native-messaging daemon
   — which this project **already has** (the Doppler sidecar) — can move the real cursor and click
   with zero in-browser tell, no portal prompt, no root, no uinput, no debugger banner.
9. Ranked: **(1)** MV3 in real Chrome + Wayland virtual-input daemon; **(2)** MV3 in real Chrome +
   session-scoped `chrome.debugger` Input; **(3)** nodriver/zendriver attached to a Chrome the user
   launched with a debug port. Camoufox 4th, agent browsers 5th.

---

## 1. MV3 extension inside the user's real Chrome (baseline)

**What/who.** The project's own harness. WXT 0.21.4 + MV3 side panel (see `extension-stack.md`).

**Layer of defence: none, and that is the point.** It does not defeat detection; it never creates the
tells. `EnableAutomationControlled` is bound only to `--enable-automation`, `--headless`,
`--remote-debugging-pipe`, and `--remote-debugging-port=0`
([runtime_features.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/child/runtime_features.cc)).
None applies. No CDP session exists unless you attach one.

**What it "spoofs": nothing — everything is genuinely real.** `navigator.webdriver` false, no
`Runtime.enable` leak, no headless tells, canvas/WebGL/audio/fonts/screen/timezone/WebRTC are the
user's actual machine, TLS JA3/JA4 + HTTP/2 SETTINGS + client hints are stock Chrome 152, IP is the
user's residential IP, and cookies/history/account age are real. **No other option on this list can
say that.**

**What still leaks — and the precedent is exact.**
- **Behaviour.** FP-Agent detected Claude for Chrome at F1≈1.0 combined
  ([arXiv:2605.01247](https://arxiv.org/abs/2605.01247), 2026-05-02). Tells named: filling fields with
  a bare `change` event, paste-based typing, inter-key and hold latency **both <1ms**, direct jumps to
  click targets with no continuous mouse movement, delete-and-retype loops, instantaneous scroll jumps.
- **Akamai, 2026-08-19** ("Identifying Agentic Automation with Behavioral Telemetry"): **63.2% of
  agentic requests contained 0 mouse events**, 35.8% more were below threshold. Their model treats
  mouse events "like language tokens". Named signals: no idle cursor movement while reading, **no
  hover before clicking**, no exploratory scrolling, and multi-second irregular pauses.
- **CHEQ, 2026-02-18** — *"The Cyborg Session: Reversing & Detecting Claude AI Agent Chrome
  Extension"* ([cheq.ai](https://cheq.ai/blog/the-cyborg-session-reversing-detecting-claude-ai-agent-chrome-extension/)).
  Someone has already productised detection of exactly this architecture. Three published methods:
  (1) WAR probe of `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/assets/accessibility-tree.js-*`;
  (2) MutationObserver on the DOM nodes it injects — `id="claude-agent-stop-container"` and
  `id="claude-agent-animation-styles"`; (3) **forensic residue** — the style element *persists after
  the agent goes idle*, so a page can tell an agent ran earlier in the session. **All three are
  self-inflicted and all three are avoidable.**
- **`isTrusted:false`** on every content-script event, plus no transient activation
  (`navigator.userActivation.isActive` stays false) — see `trusted-input-and-stealth.md` §5. Chrome
  declined to change this ([chromium-dev, 2023-01](https://groups.google.com/a/chromium.org/g/chromium-dev/c/94t2J_Jylyw)).
- **Extension enumeration.** LinkedIn's AED probes 6,167 `chrome-extension://<id>/<war>` URLs with
  `Promise.allSettled` (~50–150ms) *and* runs "Spectroscopy", a `TreeWalker` over the DOM for any
  attribute containing `chrome-extension://`
  ([leestack.dev](https://leestack.dev/writing/linkedin-aed-systems-analysis/); corroborated by
  [Castle, 2026-01-14](https://blog.castle.io/detecting-browser-extensions-for-bot-detection-lessons-from-linkedin-and-castle/)).
  `automation` is one of its 48 signals.
- **Academic base rate.** Sjösten et al., CODASPY 2017: >50% of top-1000 Chrome extensions
  WAR-detectable. Bucci & Li (LNCS, Dec 2023, 108,416 extensions): MV3 gives only a **4–10% relative
  reduction** in WAR detectability, because authors set `matches` wide. Carnus (NDSS 2020) still
  fingerprinted **83.6–87.92%** of behaviour-detectable extensions *with CloakX randomisation applied*.
  **Agarwal, Fass & Stock, ACM CCS 2024** ("Peeking through the window", tool *Raider*): 2,747 Chrome
  extensions uniquely fingerprinted, **64% via `new Error().stack` alone** — and that vector *survives
  randomised extension IDs*. Critically, Raider only works against **MAIN-world** code; the paper
  explicitly exempts isolated-world content scripts.
- **`use_dynamic_url`** ships from Chrome 130 (PSA 2024-10-09) and does kill the URL probe — but only
  that probe, adoption is near-zero, and BrowserLeaks still advertises a **fetch-timing** distinction
  ("fetching an enabled extension will, in most cases, take slightly longer"), the generalisation of
  z0ccc's 2022 bypass.

**R-01/R-05: perfect.** It *is* the user's open, logged-in tab. `chrome.sidePanel` is native.

**Drive channel.** `chrome.scripting` (world `ISOLATED`) + `chrome.runtime` messaging. The isolated
world is genuinely isolated: per Chromium's
[V8BindingDesign](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/bindings/core/v8/V8BindingDesign.md),
each world has *"its own context … its own global variable scope and prototype chains"*, so page-set
`Object.defineProperty` traps on `HTMLElement.prototype.click`/`.focus`/`dispatchEvent` **do not fire
for us**, and DOM *reads* (`querySelector`, `getBoundingClientRect`, `getComputedStyle`) are
**unobservable**. Escalation channel is `chrome.debugger` (see `trusted-input-and-stealth.md`).

**What still crosses the isolation boundary — design against exactly this list:** every DOM mutation
(MutationObserver); every event we dispatch (the page's own listeners fire and read `isTrusted`);
**`document.cookie` / `localStorage` / `sessionStorage` / IndexedDB, which are *shared* with the page
and were polled at 500ms intervals in CCS '24**; `window.postMessage` (Carnus and CCS '24 both harvest
stable message *keys*); focus changes; scroll position; injected CSS (Laperdrix et al., USENIX Sec
2021, "Fingerprinting in Style" — 4,446 extensions uniquely identified by `getComputedStyle` on
crafted trigger elements, 24% of them undetectable by every prior technique); and our own network
requests, visible via `performance.getEntriesByType("resource")`.

**Free mitigations, in evidence order:** declare **no** `web_accessible_resources`; declare **no**
`externally_connectable` (since Chrome 106, `chrome.runtime` is *undefined* on a page unless some
installed extension's `externally_connectable.matches` covers that origin — declaring it hands the
page a free bit,
[announcement 2022-08-24](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/tCWVZRq77cg/m/KB6-tvCdAgAJ));
**never** use `world: "MAIN"` (MDN's own warning: *"the web page can detect and interfere with the
executed code"*); zero page-DOM mutation and zero injected `<style>`; use `chrome.storage`, never the
page-shared stores; use `chrome.runtime` messaging, never `postMessage`. **Do not reach for
`chrome.userScripts`**: since Chrome 138 (2025-05-29) it needs a per-extension "Allow User Scripts"
toggle that is **off by default**, and `USER_SCRIPT` buys no invisibility over `ISOLATED`.

---

## 2. Camoufox

**What/who.** A hard fork of Firefox that patches fingerprint spoofing into the C++ tree.
`daijro/camoufox`, **11,645★**, MPL-2.0, last commit **2026-09-02** (`d75ebdf41a`), latest release
**v152.0.4-beta.30, 2026-09-01**. Fingerprints from `daijro/browserforge` (1,238★, Apache-2.0).

**Maintenance and governance.** daijro **stepped down** on 2026-01-10
([Discussion #452](https://github.com/daijro/camoufox/discussions/452)); Clover Labs now maintains it,
and `JWriter20` is the top commit author. The commit histogram shows **2025-04 → 2025-11 essentially
dead** (2 commits), matching the 17-month PyPI gap (0.4.11 → 0.5.3). The README's own box:
*"There has been a year gap in maintenance… Camoufox has gone down in performance due to the base
Firefox version and newly discovered fingerprint inconsistencies."* Base is Firefox **152.0.4**;
stable is **155.0** (2026-09-01) and Mozilla moved to a **2-week cadence from 155**, so the gap gets
structurally harder to hold.

**C-04 problem: it is no longer fully readable.** `upstream.sh:3` pins `closedsrc_rev=1.0.0`;
`closedsrc` is in `.gitignore` and `.dockerignore`; `.github/workflows/build.yml` passes a
`CAMOUFOX_PASSWD` secret the public Makefile never reads. `canvas:seed`/`aaOffset`/`aaCapOffset` are
declared in `settings/properties.json` with **no implementing patch in `patches/`**. **You cannot
build the shipped binary from the public repo**, and canvas spoofing in particular is closed
([#388](https://github.com/daijro/camoufox/issues/388)). C-04 says libraries are chosen *by reading
their code*. This one cannot be fully read.

**Layer: genuine C++ patches — this part is real and best-in-class.** ~37 patch files against the
Firefox tree, all reading a JSON config from `CAMOU_CONFIG_<n>` env vars via
`additions/camoucfg/MaskConfig.hpp`. Highlights: `navigator-spoofing.patch` covers
`WorkerNavigator` too (the classic JS-shim killer); `timezone-spoofing.patch` patches
`js/src/vm/DateTime.cpp` so `Date` and `Intl` agree; `screen-spoofing.patch` also patches
`nsMediaFeatures.cpp` so `matchMedia` agrees with `screen.width`; `webrtc-ip-spoofing.patch` rewrites
ICE/SDP before send; `anti-font-fingerprinting.patch` (1,424 lines) adds per-letter spacing jitter
through the whole text-shaping pipeline; `debugger-invisible-to-content.patch` adds an
`invisibleToContent` flag to SpiderMonkey's `Debugger` to hide Juggler's use of it. No
`Object.defineProperty`, no `toString` traps.

**Network layer: explicitly out of scope.** Exactly three HTTP headers are touched
(`network-patches.patch`: UA, Accept-Language, Accept-Encoding). No patch touches `security/nss` or
HTTP/2 framing. Maintainer, closing [#358](https://github.com/daijro/camoufox/issues/358) 2026-07-20:
*"our JA3 and JA4 fingerprints already match Firefox, because this **is** Firefox. Deliberately
altering them would make us stand out."* **Measured** in
[#555](https://github.com/daijro/camoufox/issues/555) (2026-04-02): Camoufox and stock-Firefox emit
**byte-identical** JA3/JA4/Akamai-H2 hashes. So the "Firefox TLS is a tell" folk claim is unsupported
— Paterson's bench put it at net zero (loses dev.to, wins google-search).

**Humanised cursor: mouse only, and thin.** `additions/camoucfg/MouseTrajectories.hpp` (235 lines,
ported from riflosnake/HumanCursor): Bézier over the endpoints plus 2 random knots, y-only Gaussian
distortion, `easeOutQuad` tween. Called from `juggler/protocol/PageHandler.js:555-576`. **No keyboard
humanisation, no scroll humanisation** — grep shows `humanize` is checked in exactly one place,
`type === 'mousemove'`. [Issue #19](https://github.com/daijro/camoufox/issues/19) (open since
2024-09) asks for typing. And `PageHandler.js:573` sleeps a **fixed 10 ms** between points, which is
itself a behavioural signature.

**What still leaks — and one of them is fatal.**
- 🔴 **13 enumerable `window.set*` functions.** On the *current* release (152.0.4-beta.30),
  `Object.keys(window).filter(k => k.startsWith("set"))` returns
  `setFontSpacingSeed, setAudioFingerprintSeed, setTimezone, setScreenDimensions, setScreenColorDepth,
  setNavigatorPlatform, setNavigatorOscpu, setNavigatorHardwareConcurrency, setWebGLVendor,
  setWebGLRenderer, setFontList, setSpeechVoices, setWebRTCIPv4`. **Stock Firefox has exactly one,
  `setResizable`.** Reported independently as
  [Discussion #723](https://github.com/daijro/camoufox/discussions/723) (2026-08-11) and
  [Issue #749](https://github.com/daijro/camoufox/issues/749) (2026-09-01, **open, no maintainer
  response**). Descriptors are `{writable, enumerable, configurable}` and `toString()` returns
  `[native code]` — so a page can both **identify Camoufox with certainty in one line** and *rewrite
  the values it is shown* (`window.setNavigatorHardwareConcurrency(999)` works from page script).
  These are WebIDL setters gated by a `Func=` check that is meant to self-destruct after the init
  script runs; **the self-destruct is not firing.**
- 🔴 **WebAssembly never tiers up.** Juggler makes every content realm a debuggee, so wasm stays on
  the baseline compiler. Measured wasm/JS timing ratio **2.49 (Camoufox) vs 0.21 (patched)** — real
  Firefox has wasm at or above JS speed. Detectable **with no fingerprint and no reference machine**
  (#723).
- **Sticky user activation with no input.** `Runtime.evaluate` calls `notifyUserGestureActivation()`,
  so any `page.evaluate` flips `navigator.userActivation.hasBeenActive` true (#723).
- **Playwright globals in the main world** — `__pwInitScripts`, `__playwright_builtins__`,
  `__playwright__binding__` enumerable on `window` in cloverlabs 0.6.0
  ([#733](https://github.com/daijro/camoufox/issues/733), 2026-08-22, open).
- Benchmarks: Paterson 2026-05-18 (651 verdicts) — **25 OK / 3 gated / 3 blocked**, mid-table, behind
  nodriver's 28/3/**0**, and the only browser blocked on dev.to; run on the stale FF135 base, so treat
  as a floor. The Web Scraping Club, 2026-07-23, 15 libraries judged by `deviceandbrowserinfo.com`:
  Camoufox was one of only **four** to pass — best-in-class in the *lab*, mid-table *live*.
- BrowserForge's Bayesian net is a **naive-Bayes star** (every node's only parent is `userAgent`), so
  GPU ⟂ screen ⟂ fonts; Pixelscan flags the results as masking
  ([#729](https://github.com/daijro/camoufox/issues/729), PR #730 open). Prefer
  `fingerprint_preset=True` — 312 real scraped device presets, `fingerprint-presets-v150.json`.
- **The SpiderMonkey wall**, conceded in Camoufox's own README: engine behaviour is observable and
  cannot be made to look like V8.

**R-01: architecturally foreclosed, not merely unsupported.** Juggler activates **only** on
`--juggler-pipe` and its transport is an **anonymous stdio pipe on fd 3/4** inherited from the
spawning process (`additions/juggler/components/Juggler.js:63-115`). There is no port, no WebSocket,
no discovery endpoint, and Playwright's Firefox has no `connect_over_cdp` equivalent. **You cannot
launch it, log in, and then attach.** `persistent_context=True` + `user_data_dir` persists logins
across *Playwright-launched* runs, but importing an existing Firefox profile is unsupported
(`policies.json` sets `DisableProfileImport: true`) — and **the user has no Firefox at all**.
The docs also say plainly: *"Camoufox is not meant for human use"*, the outer viewport can never be
resized, and the build ships `--disable-updater` + `DisableAppUpdate` — **no security updates, ever**,
on a base three releases behind.

**R-05: extensions work well; the sidebar is untested.** `browser-init.patch` adds
`installTemporaryAddon()`, signing is off (`MOZ_REQUIRE_SIGNING=` empty,
`--with-unsigned-addon-scopes=app,system`), `extensions.webextensions.restrictedDomains=""`, uBO
auto-installs. But **no reference to `sidebar` exists anywhere in `patches/`, `settings/`, or
`additions/`**, and `settings/chrome.css` hides `#unified-extensions-button` and `#PersonalToolbar`.
`sidebar_action` *should* work; it is unverified.

**The architectural killer.** Every Camoufox stealth win that matters for *acting* — isolated-world
evaluation, trusted event synthesis (`trusted-automation-events.patch`), the humanised cursor — lives
in `PageHandler.js`/`FrameTree.js`, i.e. **on the Juggler path, outside the browser**. That is the
"driven from outside" architecture R-05 and N-02 rule out. There *is* a real alternative — run the
standalone binary with `CAMOU_CONFIG_1={...}` env vars and **no** `--juggler-pipe`, driving it from a
WebExtension you write (confirmed working with no Playwright at all in
[#691](https://github.com/daijro/camoufox/discussions/691)) — but that keeps only the C++ fingerprint
spoofing and throws away every input advantage, leaving the same `isTrusted:false` content-script
input we have in Chrome. **You would pay Camoufox's entire cost for the half we need least.**

---

## 3. Patchright and rebrowser-patches — evidence, not options

Playwright is out per the user. These matter only as the public map of *which CDP leaks exist*.

**Patchright** (`Kaliiiiiiiiii-Vinyzu/patchright`, **4,262★**, Apache-2.0, pushed **2026-09-02**,
v1.62.1 2026-08-17). An AST rewrite (`patchright_driver_patch.ts`, ts-morph) of the Playwright driver
source. Leaks it removes, with mechanism:

| Leak | Patchright's fix |
| --- | --- |
| `Runtime.enable` | Never called. Execution contexts resolved manually by parsing the context id out of the `objectId` returned by `Runtime.evaluate`; iframes via `DOM.getFrameOwner`→`describeNode`→`resolveNode` |
| `Console.enable` | Never enabled — `console.log` is dead inside Patchright, by design |
| `Page.addScriptToEvaluateOnNewDocument` | Replaced by `Fetch.requestPaused` HTML rewriting with a self-removing `<script>` — **and it appends `'unsafe-eval'`, `'unsafe-inline'`, `*` to the page's `script-src`**, a real security downgrade Foil flagged and the README does not |
| `--enable-automation` / `navigator.webdriver` | Flag removed, `--disable-blink-features=AutomationControlled` added |
| Utility-world naming, closed shadow roots | Renamed / pierced |

Its README claims passes on Brotector, Cloudflare, Kasada, Akamai, Shape/F5, DataDome,
Fingerprint.com, CreepJS, Sannysoft, BrowserScan, Pixelscan — **vendor claim, no methodology, no
dates**. Independently, Paterson 2026-05-18 measured **25 OK / 3 gated / 3 blocked**, only +1 OK over
vanilla Playwright, still hard-blocked on google-search. **It does no fingerprint spoofing and no TLS
impersonation** — canvas, WebGL, audio, UA, hardware concurrency are stock. Teardown:
[Foil, 2026-05-29](https://usefoil.com/research/stealth-browsers).

**rebrowser-patches** (1,422★, **no license**, last push **2025-05-09** — ~16 months stale;
`rebrowser-bot-detector` 158★, last push 2024-10-25). Same core insight (avoid `Runtime.enable`; use
`Page.createIsolatedWorld` or `addBinding`). **Paterson measured rebrowser-playwright as functionally
identical to vanilla Playwright** — 24 OK / 2 gated / 5 blocked, *same five blocked targets*. Treat
rebrowser as historically important and currently dead.

**Two dated CDP facts worth carrying forward.**
- Around **2025-02**, Cloudflare deployed a check on a Chrome bug where CDP-synthesised clicks inside
  an iframe carried iframe-relative rather than main-frame coordinates. It hit Puppeteer, Playwright,
  Patchright, Selenium **and nodriver alike** — the tell was in Chrome, not in any library
  ([crawlex, 2026-04-11](https://blog.crawlex.net/blog/nodriver-undetected-chromedriver/)).
- **Chromium CL 6917162**, "Fix screen coordinates to avoid automation detection", merged
  **2025-09-15**, bug 40280325: *"Set PositionInScreen based on the view's actual screen bounds
  instead of copying PositionInWidget. This prevents a common automation detection fingerprint where
  screenX/Y and clientX/Y are identical."* Vinyzu **archived CDP-Patches** on 2025-09-28 with:
  *"CoalescedEvents are now also emitted by Input Events. There is no reason to use this package
  anymore, except for Select Elements."* The user runs Chrome 152 — **this is already fixed for us.**

---

## 4. nodriver / zendriver

**nodriver** (`ultrafunkamsterdam/nodriver`, **4,717★**, **AGPL-3.0**, pushed **2026-05-13**, no
GitHub releases). **zendriver** (`cdpdriver/zendriver`, **1,413★**, AGPL-3.0, pushed **2026-08-16**,
v0.16.0) is the more actively maintained fork. Predecessor `undetected-chromedriver` (12,821★) last
pushed **2025-07-05** with 1,141 open issues — effectively abandoned.

**Layer: subtraction, not patching.** No chromedriver binary, no Selenium, no Playwright — raw CDP
over a WebSocket. That deletes the entire `$cdc_` / `call_function.js` family by construction, and
removes Playwright's characteristic startup handshake (`Runtime.enable` + `Target.setAutoAttach`).

**Spoofs: essentially nothing.** No canvas/WebGL/audio/font spoofing, no TLS work. It drives the
*system Chrome*, so the fingerprint and TLS are genuinely Chrome's.

**Published testing.** Paterson 2026-05-18: **28 OK / 3 gated / 0 blocked — the only tool with zero
blocked cells**, on system Google Chrome 148. It alone passed `canadianinsider` (Cloudflare Turnstile)
where all six other stealth tools hard-blocked, reproducibly across three sweeps. The author's read:
the discriminator is **automation-protocol fingerprinting**, not cipher lists — and nodriver has no
framework shim in the control plane.

**R-01: partially, at a price.** Both expose `Browser.connect(endpoint)` / `use_running_browser(port)`
and attach to an already-running Chrome without killing it. **But** Chrome's user-data-dir singleton
lock means you cannot attach to a Chrome that was not started with `--remote-debugging-port=N` — there
is no retroactive attach. So the user's daily Chrome would have to run permanently with an open
debug port. That is a standing local-privilege hole (any local process can drive the browser and read
every logged-in session) and it is a poor fit for R-12. `N != 0` does not set `navigator.webdriver`
(only `--remote-debugging-port=0` and `--remote-debugging-pipe` do), so the flag itself is not the
problem — the exposure is.

**R-05: fails.** They are Python libraries. There is no side panel; the run is driven from outside,
which N-02 rules out.

---

## 5. Chrome-based agent / antidetect browsers

**BrowserOS** (`browseros-ai/BrowserOS`, **13,532★**, **AGPL-3.0**, pushed **2026-09-03**). A genuine
Chromium fork (Chromium 146 as of v0.42, 2026-03) plus an agent platform. Its `chromium_patches/` tree
has **10 top-level dirs** (`base chrome components content extensions third_party tools ui` + config)
and is privacy/branding/agent-UI work derived from ungoogled-chromium — e.g. the
`components/infobars/core/infobar_delegate.h` patch **adds** two BrowserOS infobar types rather than
suppressing any. A repo-wide code search for `silent-debugger-extension-api` returns **0**. **It is
not a stealth fork.** It ships a side panel (`apps/app`, WXT + React) and uses CDP internally.
"BrowserOS neo" is explicitly a *second* browser that **imports** your Chrome logins — a copy, not the
live session. R-01 fails; R-05 passes.

**Steel** (`steel-dev/steel-browser`, 7,589★, Apache-2.0, pushed 2026-09-03, v0.5.4-beta) — a
containerised browser API for agents. **Lightpanda** (34,408★, AGPL-3.0) is a headless-only
purpose-built browser: no rendering, no real fingerprint, **not relevant** to R-02.
**Browserbase / Anchor / Hyperbrowser / Kernel** are cloud browsers: datacentre IPs, someone else's
profile, and Browserbase and Anchor are in **Cloudflare's first signed-agent cohort**
([Cloudflare, 2025-08-28](https://blog.cloudflare.com/signed-agents/)) — i.e. they are designed to be
*identified*, the opposite of R-02. All of them fail R-01 outright.

**Folk remedies.** `--disable-blink-features=AutomationControlled` and `--exclude-switches` only matter
if you set `--enable-automation` in the first place; an extension never does. They are irrelevant here.

**SeleniumBase** (12,979★, MIT, pushed 2026-09-02, v4.53.6) is the community's current favourite for
Chromium stealth: UC Mode (patched chromedriver that *disconnects* WebDriver at strategic times) now
superseded by **CDP Mode** ("maximum stealth" per maintainer's own architecture chart,
[issue #4247](https://github.com/seleniumbase/SeleniumBase/issues/4247), 2026-02-18). Notably, when
CDP is not enough it falls back to **PyAutoGUI** — `sb.cdp.gui_click_element()` moves the real OS
mouse so the site sees a genuine hover before the click. That is the same conclusion as section 6.

**Multilogin / GoLogin / Kameleo / Octo / Dolphin Anty / AdsPower** — closed source. **C-04 excludes
them** ("libraries are chosen by reading their code"). None offers a "drive the session already open
in my Chrome" mode.

---

## 6. OS-level input injection — the finding that matters

**Goal:** `isTrusted:true` input with **no** `chrome.debugger`, therefore **no browser-wide infobar**
and no viewport-shrink signal.

**What is actually available on this machine (verified by inspecting the installed binaries).**

| Mechanism | Status on Hyprland 0.56.2 / Arch, 2026-09-03 |
| --- | --- |
| `zwlr_virtual_pointer_manager_v1` | **Supported.** `strings /usr/bin/Hyprland` contains the interface; [`src/protocols/VirtualPointer.cpp`](https://raw.githubusercontent.com/hyprwm/Hyprland/v0.56.2/src/protocols/VirtualPointer.cpp) emits `IPointer::SMotionEvent` / `SMotionAbsoluteEvent` / `SButtonEvent` / `SAxisEvent` / `frame` — **the same event structs as a physical pointer** |
| `zwp_virtual_keyboard_manager_v1` | **Supported.** `wtype 0.4` is already installed and uses it |
| `org.freedesktop.impl.portal.RemoteDesktop` | **NOT implemented.** `/usr/share/xdg-desktop-portal/portals/hyprland.portal` lists only `Screenshot;ScreenCast;GlobalShortcuts;InputCapture`. XDPH PR #268 (InputCapture) merged; **PR #308 (RemoteDesktop) still unmerged as of 2026-08** ([issue #252](https://github.com/hyprwm/xdg-desktop-portal-hyprland/issues/252)) |
| libei / libeis | `libei 1.6.0` installed, but only as the InputCapture (receive) side. No EIS **sender** path without RemoteDesktop. A 2026-08 comment on #252 from the `oh-my-pi` agent project records exactly this: "On Hyprland today neither exists, so input is impossible" |
| `/dev/uinput` (ydotool) | Not installed. Would work (Hyprland sees it via libinput as a normal device) but needs a root/daemon + udev setup — strictly worse than the protocol route |
| `xdotool` | X11 only. Chrome on Hyprland is a native Wayland client. Not usable |
| `hyprctl dispatch movecursor X Y` | Exists (confirmed in the binary) — moves the cursor, but there is no button dispatcher. Useful for calibration, not for clicking |

**Conclusion: skip the portal entirely.** Every third-party Hyprland "RemoteDesktop" shim
([gac3k/xdg-desktop-portal-hypr-remote](https://github.com/gac3k/xdg-desktop-portal-hypr-remote),
[hypr-kdeconnect-fix](https://github.com/gfhdhytghd/hypr-kdeconnect-fix),
[luminous](https://github.com/waycrate/xdg-desktop-portal-luminous)) is a thin D-Bus wrapper over
**exactly these two Wayland protocols**. Talk to them directly: no portal, no consent dialog, no
`restore_token`, no root, no uinput, no XWayland.

**What Chrome sees.** The compositor delivers virtual-pointer events into its normal seat and forwards
them as ordinary `wl_pointer` events. Chrome cannot distinguish them from a physical mouse: real
`isTrusted`, real `screenX/screenY`, real focus chain, real transient activation, real coalescing —
and **no automation banner, no CDP session, no `Runtime.*`, nothing for the page to enumerate.** The
only in-browser artefact is the behaviour itself, which is section 1's problem and is exactly what
FP-Agent measures.

**Coordinate mapping — the one hard part, and it is solvable.**
`MouseEvent.screenX/Y` are in **DIPs**: scaled by device-scale-factor but **not** by browser zoom;
`clientX/Y` are CSS pixels (`DIP * BrowserZoom = CssPixel`)
([w3c/pointerevents#607](https://github.com/w3c/pointerevents/issues/607), with the cross-browser
table). So the robust method is **self-calibration from the user's own mouse**: a content script
listens for real `mousemove`s and solves `screenX = originX + clientX / zoom` from two samples. That
one equation absorbs window position, browser chrome height, `devicePixelRatio`, page zoom and
fractional scaling without any Chrome API. On this machine DIP space and Hyprland logical space
coincide 1:1 (1920x1200 @ scale 1.5 = 1280x800 logical), so the daemon can use the result directly;
`hyprctl monitors -j` gives `x`, `y`, `scale` for the general multi-monitor case.

**Transport is already built.** `live-testing-real-chrome.md` §4 establishes that the extension
already calls `chrome.runtime.connectNative` to reach the Doppler sidecar, and that the port keeps the
MV3 service worker alive for a whole run. The input daemon is a message type on a port that already
exists. `nativeMessaging` is invisible to the page.

**Costs and risks, stated plainly.** The events go to the **focused window and active tab only** —
this cannot drive a background tab (the same limitation CDP-Patches documented). The real cursor
visibly moves and races the user; the run must own the pointer, or hand it back. If the window moves
mid-action the mapping is stale — re-calibrate per action, and verify with `document.elementFromPoint`
before committing a click. And nothing here bypasses behavioural fingerprinting: **trusted input with
robot kinematics is still detected.** Humanised motion is not optional, it is the product.

---

## 7. Current approaches not on the original list

- **Chrome's own actor framework.** `chrome/browser/actor` + `chrome/renderer/actor`
  (`click_dispatcher.cc`, `type_tool.cc`, `mouse_move_tool.cc`, `drag_and_release_tool.cc`) dispatch
  `blink::WebMouseEvent` through `widget->HandleInputEvent()` — trusted, no CDP, no banner. Gated to
  Glic; `kGlicActor` and `kGlicActorUi` are `FEATURE_ENABLED_BY_DEFAULT` in Chrome 152 and disabled by
  `--disable-features=GlicActor,GlicActorUi`. Its UI params (`kGlicActorUiOverlay`, `...Toast`,
  `...TabIndicator`, `...BorderGlow`, magic cursor) are all on by default: **Google's own agent
  chooses to be visible.** Strong evidence no extension trusted-input API is coming.
- **Web Bot Auth / Cloudflare signed agents.** Ed25519 HTTP message signatures (RFC 9421) with a
  `/.well-known/http-message-signatures-directory`. Cloudflare merged signed agents and verified bots
  on **2026-07-01** into Direct/Intermediary, and from **2026-09-15** blocks Agent- and
  Training-class bots by default on ad-supported pages for new/free-tier sites. This is the
  *opposite* of R-02 and is listed only so it is not mistaken for a mitigation.
- **Behavioural fingerprinting is the live frontier.** Beyond FP-Agent: HUMAN's Agentic Trust and
  DataDome's Agent Trust both shipped in 2026. Amazon v. Perplexity — Judge Chesney ruled for Amazon
  on **2026-03-10**, finding Comet accessed the site "without authorization" and "masked" its
  automated nature. Treat aggressive impersonation as carrying legal, not just technical, risk.
- **`curl_cffi`** (impersonate=chrome) scored **26 OK / 3 gated / 2 blocked** in Paterson's bench —
  tying a 130MB patched Chromium fork with a 6.4MB wheel. Relevant only for JS-free fetches, but a
  useful reminder that the network layer is cheap to get right and Chrome already gets it right.

---

## Decision matrix

Scale: ●●● strong / ●● partial / ● weak / ✗ fails. Effort is for *this* project, given WXT + a native
host already exist.

| Option | Network (TLS/H2/IP) | JS fingerprint | CDP/automation layer | Behavioural/input | R-01 open logged-in tab | R-05 side panel | Maintenance / adoption | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1. MV3 + Wayland virtual input** | ●●● real Chrome 152 | ●●● real machine | ●●● no CDP at all | ●●● trusted, humanisable | ●●● | ●●● | ●●● WXT 10.4k★; Hyprland 38.4k★ | Medium — daemon + calibration |
| **2. MV3 + session-scoped `chrome.debugger` Input** | ●●● | ●●● | ●● attach visible via infobar reflow; `screenX` fixed by CL 6917162 | ●●● trusted | ●●● | ●●● | ●●● first-party API | Low — already specced |
| **3. MV3 content-script only (today)** | ●●● | ●●● | ●●● | ● `isTrusted:false`, no activation | ●●● | ●●● | ●●● | None |
| **4. nodriver / zendriver on user's Chrome** | ●●● real Chrome | ●●● | ●●● best measured (28/3/0) | ●● CDP Input, no humanisation | ●● needs permanent `--remote-debugging-port` | ✗ | ●● 4.7k★ AGPL, nodriver 4mo stale | High + security cost |
| **5. Camoufox** | ● Firefox TLS is itself a tell | ●●● best in public | ●●● no CDP (Juggler) | ●● `humanize`, but Playwright-side only | ✗ own profile, user has no Firefox | ●● `sidebar_action` add-on, but cannot drive Juggler | ●● 11.6k★, 1yr maintenance gap, now Clover Labs | Very high |
| **6. BrowserOS / neo** | ●● Chromium fork ≠ Chrome | ● no spoofing | ● stock CDP | ● | ✗ imports logins into a 2nd browser | ●●● | ●●● 13.5k★ AGPL, daily pushes | High |
| **7. Cloud stealth browsers** | ✗ DC IP, signed-agent identity | ●● | ●● | ● | ✗ | ✗ | ●●● commercial | N/A |
| **8. Patchright / rebrowser** | ●●● / ●● | ✗ none by design | ●●● / ● (rebrowser ≡ vanilla) | ✗ | ✗ | ✗ | ●●● / ✗ (16mo stale) | — evidence only |

**Rank: 1 > 2 > 3 > 4 > 5 > 6 > 7.**

---

## Recommendation

**Stay in the user's real Chrome. This is the best-stealth choice, and the evidence is not close.**

The reason is not that MV3 is clever — it is that the real browser is the only place where the
network fingerprint, the device fingerprint, the IP reputation, the cookie jar and the account history
are all *genuinely true* rather than *convincingly forged*. Every alternative trades one of those away
to buy a control channel. And per FP-Agent, the control channel is not what current detection reads:
**behavioural features alone hit F1 = 0.9993 within 1–3 minutes**, and browser fingerprints alone only
0.7969. Optimising the harness optimises the weaker axis.

**Build, in this order:**

1. **Behavioural fidelity first, harness second.** Every named FP-Agent tell is an implementation
   choice we control: never fill a field with a bare `change` event; never paste; inter-key latency
   log-normal with a human floor (well above 1ms) and per-character variance; always move the pointer
   along a curved, bell-velocity path with overshoot before clicking; scroll in continuous bursts, not
   instantaneous jumps. This is the highest-value work and it is harness-independent.
2. **Add a Wayland virtual-input path to the existing native host.** `zwlr_virtual_pointer_v1` +
   `zwp_virtual_keyboard_v1`, calibrated from the user's own `mousemove` events. This is trusted input
   with **zero in-browser tell and no banner** — strictly better than `chrome.debugger` on R-02, and
   the marginal cost is one message type on a port the project already opens. Gate it behind R-13's
   escalation toggle exactly as the debugger path is gated.
3. **Keep `chrome.debugger` Input as the portable fallback**, session-scoped, `Input`+`DOM` only, per
   `trusted-input-and-stealth.md` §6. It is now *better than it was*: CL 6917162 removed the
   `screenX == clientX` tell in Chrome 142+, and CDP-Patches was archived because of it. The infobar
   remains the cost.
4. **Extension hygiene as a hard rule:** zero `web_accessible_resources`, `use_dynamic_url: true` if
   any become unavoidable, zero MAIN-world injection, zero persistent page DOM. LinkedIn's AED and
   Spectroscopy are the reference threat.

**What the runner-up costs in R-01 terms.** Runner-up on raw measured stealth is **nodriver/zendriver
on the user's own Chrome** — the only tool in Paterson's 651-verdict bench with zero blocked cells,
*because* it drives the user's real Chrome with no framework shim. The cost is that Chrome must be
launched permanently with `--remote-debugging-port=N` (no retroactive attach; the profile singleton
lock forbids it), which hands every local process control of every logged-in session — a direct
conflict with R-12 — and it has no side panel, so R-05 and N-02 both fail. **Camoufox costs more:**
the user has no Firefox, so R-01 fails at the first login, and because its stealth lives outside the
browser, a sidebar add-on inside it would get the same untrusted input we have today.

---

## Risks / unverified

- **FP-Agent has 0 citations and is a preprint.** Its numbers are from one honey site, three tasks,
  seven agents, fixed versions (Browser Use 0.9.2, Skyvern 0.2.23). The *direction* is well-supported
  by prior behavioural-biometrics work; the exact F1 figures are not yet replicated. Artifacts at
  `github.com/ethanbwang/fp_agent`.
- **Paterson's benchmark is one residential IP, one night, headed, 31 targets.** It measures those
  targets on 2026-05-18. `nodriver`'s clean sweep may not generalise or persist.
- **The CDP coalesced-events claim is unverified.** CL 6917162 is confirmed for `screenX/Y`; the
  "CoalescedEvents are now also emitted" line is CDP-Patches' archive notice only — I found no
  matching Chromium CL. Verify empirically with `getCoalescedEvents()` before relying on it.
- **The Wayland virtual-input path has not been executed here.** Protocol support is confirmed by
  reading the installed binary and Hyprland v0.56.2 source; end-to-end delivery into Chrome, the exact
  event timestamps/coalescing Chrome produces, and the calibration accuracy are **untested**. Build a
  spike and measure before designing around it.
- **No published project combines extension + native host + Wayland virtual input for stealth.** The
  closest public precedents are SeleniumBase's PyAutoGUI fallback and the archived CDP-Patches. We
  would be first, which means no prior art on what it leaks.
- **Camoufox maintenance is a moving target.** daijro stepped back; the handover to Clover Labs /
  JWriter20 is recent and several fingerprint-consistency PRs (#730) are unmerged. Re-check before
  any decision that depends on it.
- **Chrome could close the virtual-input path.** Nothing stops a future Chromium from distinguishing
  compositor-injected input, and nothing stops Hyprland from gating `zwlr_virtual_pointer` behind a
  prompt. Both are plausible; neither is announced.
- **Legal, not technical.** Amazon v. Perplexity (2026-03-10) treats "masking the automated nature" of
  an agent as an authorization problem. R-02 has a ceiling that is not made of code.
