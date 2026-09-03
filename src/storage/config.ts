import { storage } from '#imports';

/** How the agent perceives the page (R-08). */
export type ObserveMode = 'dom' | 'pixels' | 'both';

/** How input is delivered (R-13). `escalated` means debugger/CDP-backed trusted input. */
export type InputFidelity = 'in-page' | 'escalated';

/** User-owned run configuration. The side panel is the boss (R-05/R-11). */
export interface Config {
  leaderModel: string;
  followerModel: string;
  observe: ObserveMode;
  planningInterval: number;
  maxSteps: number;
  inputFidelity: InputFidelity;
}

export const DEFAULT_CONFIG: Config = {
  leaderModel: '',
  followerModel: '',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 50,
  inputFidelity: 'in-page',
};

export const configItem = storage.defineItem<Config>('local:config', {
  fallback: DEFAULT_CONFIG,
  version: 1,
});

export async function getConfig(): Promise<Config> {
  return configItem.getValue();
}

/** Merges a partial update over the stored config and returns the result. */
export async function setConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await configItem.getValue()), ...patch };
  await configItem.setValue(next);
  return next;
}

export async function resetConfig(): Promise<void> {
  await configItem.removeValue();
}
