// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { freeOnlyItem, useFreeModelsOnly } from './modelFilter';

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
