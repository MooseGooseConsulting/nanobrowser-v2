/**
 * The current run's `run.started` timestamp, threaded past every event card so
 * `EventShell` can render relative timestamps (Requirement 4, `+12.4s`) without every
 * card needing its own copy of it. `undefined` (the default, no provider) falls back
 * to an absolute clock time — this is what lets `HandoffCard`, `ToolCallCard` etc.
 * still render correctly in isolation, e.g. in their own component tests.
 */
import { createContext, useContext } from 'react';

export const RunStartContext = createContext<number | undefined>(undefined);

export function useRunStart(): number | undefined {
  return useContext(RunStartContext);
}
