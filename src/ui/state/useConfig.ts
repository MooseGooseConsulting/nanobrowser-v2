import { useCallback, useEffect, useState } from 'react';
import { configItem, DEFAULT_CONFIG, resetConfig, setConfig, type Config } from '@/src/storage';

export interface ConfigApi {
  config: Config;
  /** False until the stored value has been read, so the form never flashes defaults over it. */
  loaded: boolean;
  update: (patch: Partial<Config>) => void;
  reset: () => void;
}

/**
 * The panel owns the run configuration (R-05/R-11): every change is written straight to
 * the WXT storage item and every instance of this hook follows the item's watcher, so
 * Setup and the Run button never disagree and the whole thing restores on reopen.
 */
export function useConfig(): ConfigApi {
  const [config, setLocal] = useState<Config>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void configItem
      .getValue()
      .then((value) => {
        if (!live) return;
        setLocal(value);
        setLoaded(true);
      })
      .catch(() => {
        if (live) setLoaded(true);
      });
    const unwatch = configItem.watch((value) => setLocal(value ?? DEFAULT_CONFIG));
    return () => {
      live = false;
      unwatch();
    };
  }, []);

  const update = useCallback((patch: Partial<Config>) => {
    // Optimistic: the watcher confirms, but the control must not lag a keystroke behind.
    setLocal((prev) => ({ ...prev, ...patch }));
    void setConfig(patch).catch(() => undefined);
  }, []);

  const reset = useCallback(() => {
    setLocal(DEFAULT_CONFIG);
    void resetConfig().catch(() => undefined);
  }, []);

  return { config, loaded, update, reset };
}
