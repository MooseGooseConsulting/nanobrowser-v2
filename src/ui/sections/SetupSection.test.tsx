// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ModelInfo } from '@/src/messaging';
import { DEFAULT_CONFIG, configItem, getConfig } from '@/src/storage';
import { SetupSection } from './SetupSection';

afterEach(cleanup);
beforeEach(() => {
  fakeBrowser.reset();
});

const MODELS: ModelInfo[] = [
  { id: 'nvidia/nemotron-ultra', name: 'NVIDIA Nemotron Ultra', free: false, vision: true, tools: true, contextLength: 1_000_000 },
  { id: 'meta/llama-4', name: 'Llama 4', free: true, vision: false, tools: true, contextLength: 256_000 },
];

const READY = { hostConnected: true, keyReady: true };

function setup(over: Partial<Parameters<typeof SetupSection>[0]> = {}) {
  return render(
    <SetupSection
      models={MODELS}
      modelsStatus="ready"
      onRefreshModels={vi.fn()}
      readiness={READY}
      readinessStatus="ready"
      onRefreshReadiness={vi.fn()}
      {...over}
    />,
  );
}

describe('SetupSection config persistence', () => {
  it('writes every change to the Config storage item', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Nemotron/ }));
    await waitFor(async () =>
      expect((await getConfig()).leaderModel).toBe('nvidia/nemotron-ultra'),
    );

    await user.click(screen.getByRole('combobox', { name: 'Follower model' }));
    await user.click(screen.getByRole('option', { name: /Llama 4/ }));

    await user.click(screen.getByRole('radio', { name: 'Pixels' }));
    await user.click(screen.getByRole('switch', { name: 'Escalate to trusted input' }));

    await waitFor(async () =>
      expect(await getConfig()).toEqual({
        ...DEFAULT_CONFIG,
        leaderModel: 'nvidia/nemotron-ultra',
        followerModel: 'meta/llama-4',
        observe: 'pixels',
        inputFidelity: 'escalated',
      }),
    );
  });

  it('restores a stored config on mount, so reopening the panel keeps the setup', async () => {
    await configItem.setValue({
      leaderModel: 'nvidia/nemotron-ultra',
      followerModel: 'meta/llama-4',
      observe: 'both',
      planningInterval: 3,
      maxSteps: 120,
      inputFidelity: 'escalated',
    });

    setup();

    const leader = await screen.findByDisplayValue('NVIDIA Nemotron Ultra');
    expect(leader).toBeTruthy();
    expect(screen.getByDisplayValue('Llama 4')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true),
    );
    expect((screen.getByLabelText('Planning interval') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Max steps') as HTMLInputElement).value).toBe('120');
    expect(
      screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('persists validated cadence values and flags invalid ones', async () => {
    const user = userEvent.setup();
    setup();

    const interval = screen.getByLabelText('Planning interval');
    await user.clear(interval);
    await user.type(interval, '7');
    await waitFor(async () => expect((await getConfig()).planningInterval).toBe(7));

    await user.clear(interval);
    expect(interval.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/whole number from 1 to 100/);
  });

  it('resets to defaults', async () => {
    const user = userEvent.setup();
    await configItem.setValue({ ...DEFAULT_CONFIG, leaderModel: 'meta/llama-4', maxSteps: 3 });
    setup();

    await screen.findByDisplayValue('Llama 4');
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    await waitFor(async () => expect(await getConfig()).toEqual(DEFAULT_CONFIG));
    expect((screen.getByLabelText('Max steps') as HTMLInputElement).value).toBe('50');
  });

  it('explains that escalated input raises Chrome\'s debugger banner', () => {
    setup();
    expect(screen.getByTestId('fidelity-explainer').textContent).toMatch(/debugging this browser/i);
  });
});

describe('SetupSection readiness row', () => {
  it('is green when the worker validates the host and the key', () => {
    setup();
    expect(screen.getByTestId('readiness-row').getAttribute('data-ready')).toBe('true');
    expect(screen.queryByTestId('readiness-reason')).toBeNull();
  });

  it('shows the specific reason when it is not', () => {
    setup({
      readiness: { hostConnected: true, keyReady: false, reason: 'Doppler returned no key' },
    });
    expect(screen.getByTestId('readiness-row').getAttribute('data-ready')).toBe('false');
    expect(screen.getByTestId('readiness-reason').textContent).toBe('Doppler returned no key');
  });

  it('degrades to "waiting for worker" when nothing has answered', () => {
    setup({ readiness: undefined, readinessStatus: 'waiting', modelsStatus: 'waiting', models: [] });
    expect(screen.getByText('Waiting for worker')).toBeTruthy();
    expect(screen.getByTestId('readiness-reason').textContent).toMatch(/waiting for the worker/i);
    expect(screen.getByText(/Waiting for the worker to send the model list/)).toBeTruthy();
  });

  it('rechecks on demand', async () => {
    const user = userEvent.setup();
    const onRefreshReadiness = vi.fn();
    setup({ onRefreshReadiness });
    await user.click(screen.getByRole('button', { name: 'recheck' }));
    expect(onRefreshReadiness).toHaveBeenCalledOnce();
  });
});
