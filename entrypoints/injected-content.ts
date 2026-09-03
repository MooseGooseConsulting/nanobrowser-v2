import { defineUnlistedScript } from '#imports';

/**
 * On-demand page script. Deliberately NOT declared in the manifest: nothing runs on a page
 * until the service worker injects it with `chrome.scripting.executeScript` into the
 * ISOLATED world (R-02). Declared content scripts are a standing, enumerable surface;
 * Running in the page's MAIN world is banned outright and enforced by
 * scripts/check-invariants.sh; userscripts go through chrome.userScripts instead.
 *
 * Injected file path in the build output: `injected-content.js`.
 */
export default defineUnlistedScript(() => {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'ping') {
      sendResponse({ type: 'pong', at: Date.now() });
      return true;
    }
    return false;
  });
});
