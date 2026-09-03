// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunEvent } from '@/src/messaging';
import { DEFAULT_CONFIG, type Config } from '@/src/storage';
import { initialRunLogState, runLogReducer, type RunLogState } from '../state/runlog';
import { RunSection } from './RunSection';

afterEach(cleanup);

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  leaderModel: 'nvidia/nemotron-ultra',
  followerModel: 'meta/llama-4',
};

const READY = { hostConnected: true, keyReady: true };

function logOf(events: RunEvent[], runId = 'run-1'): RunLogState {
  return events.reduce(
    (state, event) => runLogReducer(state, { type: 'event', runId, event }),
    initialRunLogState,
  );
}

const started: RunEvent = {
  kind: 'run.started',
  runId: 'run-1',
  prompt: 'buy the thing',
  config: CONFIG,
  tabId: 7,
  url: 'https://example.com/cart',
  at: 1,
};

function setup(over: Partial<Parameters<typeof RunSection>[0]> = {}) {
  const handlers = {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onAbort: vi.fn(),
  };
  render(
    <RunSection
      config={CONFIG}
      readiness={READY}
      readinessStatus="ready"
      log={initialRunLogState}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe('Run button gating', () => {
  it('is disabled while readiness has not come back', async () => {
    const user = userEvent.setup();
    setup({ readiness: undefined, readinessStatus: 'waiting' });

    await user.type(screen.getByLabelText('Objective'), 'do a thing');
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;

    expect(run.disabled).toBe(true);
    expect(screen.getByTestId('run-blocked-reason').textContent).toMatch(/waiting for the worker/i);
  });

  it('is disabled with a specific reason when readiness is red', () => {
    setup({ readiness: { hostConnected: false, keyReady: false, reason: 'host offline' } });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-blocked-reason').textContent).toBe('host offline');
  });

  it('is disabled when readiness is green but a model is unpicked', () => {
    setup({ config: { ...CONFIG, followerModel: '' } });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-blocked-reason').textContent).toMatch(/follower model/i);
  });

  it('is disabled with an empty prompt even when everything is green', () => {
    setup();
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('run-blocked-reason')).toBeNull();
  });

  it('enables and starts once readiness is green and a prompt is typed', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.type(screen.getByLabelText('Objective'), '  buy the thing  ');
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);

    await user.click(run);
    expect(handlers.onStart).toHaveBeenCalledExactlyOnceWith('buy the thing');
  });
});

describe('transport controls', () => {
  it('offers only Run while idle', () => {
    setup();
    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button('Pause').disabled).toBe(true);
    expect(button('Resume').disabled).toBe(true);
    expect(button('Abort').disabled).toBe(true);
  });

  it('offers Pause and Abort while running', async () => {
    const user = userEvent.setup();
    const handlers = setup({ log: logOf([started]) });
    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

    expect(button('Run').disabled).toBe(true);
    expect(button('Pause').disabled).toBe(false);
    expect(button('Resume').disabled).toBe(true);
    expect(button('Abort').disabled).toBe(false);

    await user.click(button('Pause'));
    await user.click(button('Abort'));
    expect(handlers.onPause).toHaveBeenCalledOnce();
    expect(handlers.onAbort).toHaveBeenCalledOnce();
  });

  it('offers Resume once paused', async () => {
    const user = userEvent.setup();
    const handlers = setup({ log: logOf([started, { kind: 'run.paused', at: 2 }]) });
    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

    expect(button('Pause').disabled).toBe(true);
    expect(button('Resume').disabled).toBe(false);
    await user.click(button('Resume'));
    expect(handlers.onResume).toHaveBeenCalledOnce();
  });

  it('re-enables Run after the run ends', () => {
    setup({
      log: logOf([started, { kind: 'run.ended', status: 'done', message: 'ok', steps: 4, at: 3 }]),
    });
    expect((screen.getByRole('button', { name: 'Abort' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-ended').textContent).toContain('done');
  });
});

describe('run log', () => {
  it('renders events in arrival order with one card per kind', () => {
    setup({
      log: logOf([
        started,
        { kind: 'leader.plan', plan: 'find the cart', subgoals: ['open cart'], replan: false, at: 2 },
        { kind: 'tool.call', role: 'follower', call: { callId: 'c1', name: 'click', args: { at: 1 } }, at: 3 },
        { kind: 'tool.result', role: 'follower', result: { callId: 'c1', name: 'click', ok: true, summary: 'clicked', durationMs: 8 }, at: 4 },
        { kind: 'handoff', from: 'follower', to: 'leader', reason: 'done', signal: 'SUBGOAL_COMPLETE', at: 5 },
      ]),
    });

    const items = screen.getByTestId('run-log').children;
    expect(items).toHaveLength(4);
    expect(screen.getByTestId('plan-card')).toBeTruthy();
    expect(screen.getByTestId('handoff-card')).toBeTruthy();
    expect(screen.getByTestId('tool-call-summary')).toBeTruthy();
  });

  it('filters by kind without hiding run lifecycle events', async () => {
    const user = userEvent.setup();
    setup({
      log: logOf([
        started,
        { kind: 'step', n: 1, role: 'leader', at: 2 },
        { kind: 'handoff', from: 'leader', to: 'follower', reason: 'go', at: 3 },
      ]),
    });

    expect(screen.getByTestId('run-log').children).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'steps' }));
    expect(screen.getByTestId('run-log').children).toHaveLength(2);
    expect(screen.getByTestId('handoff-card')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'handoffs' }));
    expect(screen.getByTestId('run-log').children).toHaveLength(1);
  });

  it('copies the raw event list as JSON', async () => {
    const user = userEvent.setup();
    // `userEvent.setup()` installs its own clipboard stub, so replace it afterwards.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const log = logOf([started]);
    setup({ log });

    await user.click(screen.getByRole('button', { name: 'copy JSON' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(log.events, null, 2));
  });

  it('exposes the bottom-pin toggle', async () => {
    const user = userEvent.setup();
    setup({ log: logOf([started]) });

    const pin = screen.getByRole('switch', { name: 'Pin the log to the bottom' });
    expect(pin.getAttribute('aria-checked')).toBe('true');
    await user.click(pin);
    expect(pin.getAttribute('aria-checked')).toBe('false');
  });

  it('says it is re-attached when a runId is known but no events have arrived', () => {
    setup({ log: runLogReducer(initialRunLogState, { type: 'run', runId: 'run-9' }) });
    expect(screen.getByText(/waiting for the worker to send its log/i)).toBeTruthy();
  });
});

describe('start hand-off to the worker', () => {
  it('blocks a second Run while the worker has not acknowledged the first', () => {
    setup({ starting: true });
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Abort' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
