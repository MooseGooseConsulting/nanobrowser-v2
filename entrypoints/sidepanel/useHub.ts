import { useEffect, useState } from 'react';
import { ChromePort, createChannel, HUB_MESSAGE, SIDEPANEL_PORT } from '@/src/messaging';
import type { HubInbound, HubOutbound } from '@/src/messaging';

export type HubStatus = 'connecting' | 'connected' | 'disconnected';

export interface HubState {
  status: HubStatus;
  extensionVersion?: string;
  lastPongAt?: number;
}

/** Live connection to the service worker's port hub (R-07: the panel observes the run). */
export function useHub(): HubState {
  const [state, setState] = useState<HubState>({ status: 'connecting' });

  useEffect(() => {
    const channel = createChannel<HubOutbound, HubInbound>(
      new ChromePort(chrome.runtime.connect({ name: SIDEPANEL_PORT })),
    );

    channel.onMessage(({ type, payload }) => {
      if (type !== HUB_MESSAGE) return;
      if (payload.kind === 'hello') {
        setState({ status: 'connected', extensionVersion: payload.extensionVersion });
      } else {
        setState((prev) => ({ ...prev, status: 'connected', lastPongAt: payload.at }));
      }
    });
    channel.onClose(() => setState((prev) => ({ ...prev, status: 'disconnected' })));

    const heartbeat = setInterval(() => {
      channel.send(HUB_MESSAGE, { kind: 'ping', at: Date.now() });
    }, 5_000);

    return () => {
      clearInterval(heartbeat);
      channel.close();
    };
  }, []);

  return state;
}
