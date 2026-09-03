/** Name of the long-lived port the side panel opens to the service worker. */
export const SIDEPANEL_PORT = 'nanobrowser:sidepanel';

/** Messages the service worker sends to the side panel. */
export type HubOutbound =
  | { kind: 'hello'; extensionVersion: string }
  | { kind: 'pong'; at: number };

/** Messages the side panel sends to the service worker. */
export type HubInbound = { kind: 'ping'; at: number };

export const HUB_MESSAGE = 'hub';
