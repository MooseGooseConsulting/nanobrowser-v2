import { defineUnlistedScript } from '#imports';
import { installPageListener } from '@/src/page/handler';

/**
 * On-demand page script. Deliberately NOT declared in the manifest: nothing runs on a page
 * until the service worker injects it with `chrome.scripting.executeScript` into the
 * ISOLATED world (R-02). Declared content scripts are a standing, enumerable surface;
 * Running in the page's MAIN world is banned outright and enforced by
 * scripts/check-invariants.sh; userscripts go through chrome.userScripts instead.
 *
 * Injected file path in the build output: `injected-content.js`.
 *
 * The ONLY side effect of injection is registering a single `chrome.runtime.onMessage`
 * listener (`src/page/handler.ts`), which is idempotent across re-injection. No DOM is read
 * or written, no observer is attached and no timer is started until an op arrives; the page
 * gains no global, no attribute, no node and no stylesheet at any point (ranked-leak rows
 * 4, 9, 11 and 12).
 *
 * Everything this listener can do — snapshot, click, type, press, select, scroll, getBox,
 * hover — is the R-13 "in-page" tier and therefore dispatches `isTrusted:false` events.
 * Escalation to trusted input is the debugger/CDP tier's job, not this file's.
 */
export default defineUnlistedScript(() => {
  installPageListener();
});
