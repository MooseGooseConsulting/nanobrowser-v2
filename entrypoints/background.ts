import { defineBackground } from '#imports';
import { ChromePort, createChannel, SIDEPANEL_PORT, HUB_MESSAGE } from '@/src/messaging';
import type { HubInbound, HubOutbound } from '@/src/messaging';

export default defineBackground(() => {
  // The toolbar action opens the side panel (R-05). Chrome 114+, needs the sidePanel permission.
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error: unknown) => console.error('[nanobrowser] setPanelBehavior failed', error));
  });

  // Port hub: every side panel that connects gets a typed channel. The hub owns them,
  // so run-log fan-out later has exactly one place to write to.
  const panels = new Set<ReturnType<typeof createChannel<HubInbound, HubOutbound>>>();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDEPANEL_PORT) return;

    const channel = createChannel<HubInbound, HubOutbound>(new ChromePort(port));
    panels.add(channel);
    channel.onClose(() => panels.delete(channel));

    channel.onMessage((message) => {
      if (message.type !== HUB_MESSAGE) return;
      if (message.payload.kind === 'ping') {
        channel.send(HUB_MESSAGE, { kind: 'pong', at: Date.now() });
      }
    });

    channel.send(HUB_MESSAGE, {
      kind: 'hello',
      extensionVersion: chrome.runtime.getManifest().version,
    });
  });
});
