/**
 * "Free models only" is a panel display preference, not part of the run `Config`
 * contract (src/storage/config.ts), so it gets its own tiny storage item rather than
 * a new field on Config. It DEFAULTS ON: the user has authorised only free OpenRouter
 * models (the nvidia/nemotron *:free pair) as the enforced norm, so every fresh panel
 * starts filtered to them and picking a paid model is an explicit, warned choice.
 */
import { useEffect, useState } from 'react';
import { storage } from '#imports';
import type { ModelSource } from '@/src/storage';

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

/** Which catalog source the Setup tab's model pickers show. Defaults to 'all' -- adding Kilo must never hide a model that was visible before. */
export type SourceFilter = ModelSource | 'all';

export const modelSourceFilterItem = storage.defineItem<SourceFilter>('local:setup.modelSource', {
  fallback: 'all',
});

export function useModelSourceFilter(): [SourceFilter, (next: SourceFilter) => void] {
  const [source, setSource] = useState<SourceFilter>('all');

  useEffect(() => {
    let live = true;
    void modelSourceFilterItem.getValue().then((value) => {
      if (live) setSource(value);
    });
    const unwatch = modelSourceFilterItem.watch((value) => setSource(value ?? 'all'));
    return () => {
      live = false;
      unwatch();
    };
  }, []);

  const update = (next: SourceFilter) => {
    setSource(next);
    void modelSourceFilterItem.setValue(next);
  };

  return [source, update];
}
