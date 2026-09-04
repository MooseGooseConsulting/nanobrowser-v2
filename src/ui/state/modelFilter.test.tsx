// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { freeOnlyItem, modelSourceFilterItem, useFreeModelsOnly, useModelSourceFilter } from './modelFilter';

afterEach(cleanup);

beforeEach(() => {
  fakeBrowser.reset();
});

function Probe() {
  const [freeOnly, setFreeOnly] = useFreeModelsOnly();
  return (
    <button type="button" onClick={() => setFreeOnly(!freeOnly)}>
      {freeOnly ? 'free-only:on' : 'free-only:off'}
    </button>
  );
}

describe('useFreeModelsOnly', () => {
  it('defaults on, per the enforced norm', async () => {
    render(<Probe />);
    await screen.findByText('free-only:on');
  });

  it('persists a change to storage', async () => {
    render(<Probe />);
    await screen.findByText('free-only:on');
    await act(async () => screen.getByRole('button').click());
    await screen.findByText('free-only:off');
    await waitFor(async () => expect(await freeOnlyItem.getValue()).toBe(false));
  });

  it('follows a value set directly on the storage item', async () => {
    await freeOnlyItem.setValue(false);
    render(<Probe />);
    await screen.findByText('free-only:off');
  });
});

function SourceProbe() {
  const [source, setSource] = useModelSourceFilter();
  return (
    <div>
      <span>source:{source}</span>
      <button type="button" onClick={() => setSource('kilo')}>
        pick kilo
      </button>
    </div>
  );
}

describe('useModelSourceFilter', () => {
  it('defaults to "all", so adding Kilo never hides a model that was visible before', async () => {
    render(<SourceProbe />);
    await screen.findByText('source:all');
  });

  it('persists a change to storage', async () => {
    render(<SourceProbe />);
    await screen.findByText('source:all');
    await act(async () => screen.getByRole('button').click());
    await screen.findByText('source:kilo');
    await waitFor(async () => expect(await modelSourceFilterItem.getValue()).toBe('kilo'));
  });

  it('follows a value set directly on the storage item', async () => {
    await modelSourceFilterItem.setValue('openrouter');
    render(<SourceProbe />);
    await screen.findByText('source:openrouter');
  });
});
