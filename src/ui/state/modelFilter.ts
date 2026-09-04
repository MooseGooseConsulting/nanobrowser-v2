/**
 * "Free models only" is a panel display preference, not part of the run `Config`
 * contract (src/storage/config.ts), so it gets its own tiny storage item rather than
 * a new field on Config. It DEFAULTS ON: the user has authorised only free OpenRouter
 * models (the nvidia/nemotron *:free pair) as the enforced norm, so every fresh panel
 * starts filtered to them and picking a paid model is an explicit, warned choice.
 */
import { useEffect, useState } from 'react';
import { storage } from '#imports';

export const freeOnlyItem = storage.defineItem<boolean>('local:setup.freeModelsOnly', {
  fallback: true,
});

export function useFreeModelsOnly(): [boolean, (next: boolean) => void] {
  const [freeOnly, setFreeOnly] = useState(true);

  useEffect(() => {
    let live = true;
    void freeOnlyItem.getValue().then((value) => {
      if (live) setFreeOnly(value);
    });
    const unwatch = freeOnlyItem.watch((value) => setFreeOnly(value ?? true));
    return () => {
      live = false;
      unwatch();
    };
  }, []);

  const update = (next: boolean) => {
    setFreeOnly(next);
    void freeOnlyItem.setValue(next);
  };

  return [freeOnly, update];
}
