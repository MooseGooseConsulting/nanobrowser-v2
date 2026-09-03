/**
 * The service worker. Thin on purpose: it constructs the real adapters and hands
 * them to `createWorker` (src/runtime/worker.ts), which owns every message.
 *
 * Nothing here has logic worth testing — the seams below (`HostClient`,
 * `PageDriver`, `chromeTabsPort`, `createChromeDebuggerApi`) are each covered by
 * their own subsystem's tests, and the wiring they feed is covered by
 * `src/runtime/*.test.ts` with fakes.
 */
import { defineBackground } from '#imports';
import { ChromePort, SIDEPANEL_PORT } from '@/src/messaging';
import { createChatModel, DEFAULT_BASE_URL } from '@/src/agent/models';
import { createChromeDebuggerApi, DebuggerInputTier } from '@/src/input';
import { HostClient, createHostFetch } from '@/src/host';
import { PageDriver } from '@/src/page';
import { getConfig } from '@/src/storage';
import { getUserscript, runUserscript, seedDefaults } from '@/src/userscripts';
import { RunManager, chromeTabsPort, createWorker } from '@/src/runtime';
import { setLastRunId } from '@/src/ui/state/lastRun';

export default defineBackground(() => {
  // The toolbar action opens the side panel (R-05). Chrome 114+, needs the sidePanel permission.
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error('[nanobrowser] setPanelBehavior failed', error));

  chrome.runtime.onInstalled.addListener(() => {
    // The bundled example userscripts land on first install (R-09).
    void seedDefaults().catch((error: unknown) =>
      console.error('[nanobrowser] seedDefaults failed', error),
    );
  });

  const host = new HostClient();
  const hostFetch = createHostFetch(host);
  const driver = new PageDriver();

  const runManager = new RunManager({
    driver,
    tabs: chromeTabsPort(),
    host,
    // C-07: the host holds the key; the panel picks the models, one per role (R-11).
    createModel: (model) => createChatModel({ model, fetch: hostFetch, baseURL: DEFAULT_BASE_URL }),
    makeDebuggerTier: (onDetach) => new DebuggerInputTier(createChromeDebuggerApi(), { onDetach }),
    runUserscript: async (scriptId, tabId) => {
      const script = await getUserscript(scriptId);
      if (!script) {
        return { scriptId, ok: false, error: `unknown userscript: ${scriptId}`, console: [], durationMs: 0 };
      }
      return runUserscript({ tabId, script });
    },
    saveLastRunId: setLastRunId,
  });

  const worker = createWorker({
    host,
    runManager,
    getConfig,
    extensionVersion: chrome.runtime.getManifest().version,
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDEPANEL_PORT) return;
    worker.connect(new ChromePort(port));
  });
});
