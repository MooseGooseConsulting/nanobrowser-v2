/**
 * The id of the run the panel was last watching, in `chrome.storage.session` so it
 * survives the panel being closed and reopened but never outlives the browser
 * session. On mount the panel replays this run rather than showing an empty log.
 */
import { storage } from '#imports';

export const lastRunIdItem = storage.defineItem<string | null>('session:lastRunId', {
  fallback: null,
});

export async function getLastRunId(): Promise<string | null> {
  return lastRunIdItem.getValue();
}

export async function setLastRunId(runId: string): Promise<void> {
  await lastRunIdItem.setValue(runId);
}
