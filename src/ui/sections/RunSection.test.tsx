// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelInfo, RunEvent } from '@/src/messaging';
import { DEFAULT_CONFIG, type Config } from '@/src/storage';
import { initialRunLogState, runLogReducer, type RunLogState } from '../state/runlog';
import { RunSection } from './RunSection';

afterEach(cleanup);

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  leaderModel: 'nvidia/nemotron-ultra',
  followerModel: 'meta/llama-4',
};

const MODELS: ModelInfo[] = [
  { id: 'nvidia/nemotron-ultra', name: 'NVIDIA Nemotron Ultra', free: false, vision: true, tools: true, contextLength: 1_000_000 },
  { id: 'meta/llama-4', name: 'Llama 4', free: true, vision: false, tools: true, contextLength: 256_000 },
];

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
    onGoToSetup: vi.fn(),
  };
  render(
    <RunSection
      config={CONFIG}
      models={MODELS}
      readiness={READY}
      readinessStatus="ready"
      log={initialRunLogState}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe('composer', () => {
  it('shows the chosen Leader/Follower as chips, with a change link to Setup', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    expect(screen.getByText('NVIDIA Nemotron Ultra')).toBeTruthy();
    expect(screen.getByText('Llama 4')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'change' }));
    expect(handlers.onGoToSetup).toHaveBeenCalledOnce();
  });

  it('submits with plain Enter', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.type(screen.getByLabelText('Objective'), 'buy the thing');
    await user.keyboard('{Enter}');

    expect(handlers.onStart).toHaveBeenCalledExactlyOnceWith('buy the thing');
  });

  it('inserts a newline on Shift+Enter instead of submitting', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const textarea = screen.getByLabelText('Objective') as HTMLTextAreaElement;

    await user.type(textarea, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textarea, 'line two');

    expect(textarea.value).toBe('line one\nline two');
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('still submits with Ctrl+Enter, for anyone with the old habit', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.type(screen.getByLabelText('Objective'), 'buy the thing');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(handlers.onStart).toHaveBeenCalledExactlyOnceWith('buy the thing');
  });

  it('does not submit plain Enter while the gate is not open', async () => {
    const user = userEvent.setup();
    const handlers = setup({ config: { ...CONFIG, followerModel: '' } });

    await user.type(screen.getByLabelText('Objective'), 'buy the thing');
    await user.keyboard('{Enter}');

    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('hides the "change" link once the blocked-reason bar already offers its own Fix in Setup, to avoid a duplicate CTA', () => {
    setup({ readiness: { hostConnected: false, keyReady: false, reason: 'host offline' } });

    expect(screen.queryByRole('button', { name: 'change' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Fix in Setup' })).toBeTruthy();
  });
});

describe('Run button gating', () => {
  it('is disabled while readiness has not come back', async () => {
    const user = userEvent.setup();
    setup({ readiness: undefined, readinessStatus: 'waiting' });

    await user.type(screen.getByLabelText('Objective'), 'do a thing');
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;

    expect(run.disabled).toBe(true);
    expect(screen.getByTestId('run-blocked-reason').textContent).toMatch(/waiting for the worker/i);
  });

  it('is disabled with a specific reason when readiness is red, with a fix action to Setup', async () => {
    const user = userEvent.setup();
    const handlers = setup({ readiness: { hostConnected: false, keyReady: false, reason: 'host offline' } });
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-blocked-reason').textContent).toContain('host offline');

    await user.click(within(screen.getByTestId('run-blocked-reason')).getByRole('button', { name: 'Fix in Setup' }));
    expect(handlers.onGoToSetup).toHaveBeenCalledOnce();
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

describe('transport controls: only the applicable ones render', () => {
  it('offers only Run while idle', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
  });

  it('offers Pause and Abort while running, not Resume', async () => {
    const user = userEvent.setup();
    const handlers = setup({ log: logOf([started]) });

    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Abort' }));
    expect(handlers.onPause).toHaveBeenCalledOnce();
    expect(handlers.onAbort).toHaveBeenCalledOnce();
  });

  it('offers Resume once paused, not Pause', async () => {
    const user = userEvent.setup();
    const handlers = setup({ log: logOf([started, { kind: 'run.paused', at: 2 }]) });

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(handlers.onResume).toHaveBeenCalledOnce();
  });

  it('re-enables Run and hides transport controls once the run ends', () => {
    setup({
      log: logOf([started, { kind: 'run.ended', status: 'done', message: 'ok', steps: 4, at: 3 }]),
    });
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
    expect(screen.getByTestId('run-result-card').textContent).toContain('Done');
  });

  it('replaces Abort with an "Aborting…" status once clicked, until the run ends', async () => {
    const user = userEvent.setup();
    setup({ log: logOf([started]) });

    await user.click(screen.getByRole('button', { name: 'Abort' }));
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
    const strip = screen.getAllByRole('status').find((el) => /aborting/i.test(el.textContent ?? ''));
    expect(strip).toBeTruthy();
  });
});

describe('status strip', () => {
  it('is an aria-live region showing state, step N of maxSteps, and the current subgoal', () => {
    setup({
      log: logOf([
        started,
        { kind: 'leader.plan', plan: 'p', subgoals: ['open cart', 'checkout'], replan: false, at: 2 },
        { kind: 'step', n: 3, role: 'follower', at: 3 },
      ]),
    });

    const strips = screen.getAllByRole('status');
    const strip = strips.find((el) => /running/i.test(el.textContent ?? ''));
    expect(strip).toBeTruthy();
    expect(strip?.getAttribute('aria-live')).toBe('polite');
    expect(strip?.textContent).toContain('step 3 of');
    expect(strip?.textContent).toContain('open cart');
  });

  it('does not render while idle', () => {
    setup();
    expect(screen.queryByText(/^Running$/)).toBeNull();
  });
});

describe('run log', () => {
  it('hides the Show/pin/copy toolbar until the log has events, so idle has nothing to filter, pin or copy', () => {
    setup();

    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Pin the log to the bottom' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'copy JSON' })).toBeNull();
  });

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

    const items = within(screen.getByTestId('run-log')).getAllByTestId('log-entry');
    expect(items).toHaveLength(4);
    expect(screen.getByTestId('plan-card')).toBeTruthy();
    expect(screen.getByTestId('handoff-card')).toBeTruthy();
    expect(screen.getByTestId('tool-call-summary')).toBeTruthy();
  });

  it('groups a Follower step behind a collapsible "Step N" section, open by default', () => {
    setup({
      log: logOf([
        started,
        { kind: 'step', n: 1, role: 'follower', at: 2 },
        { kind: 'tool.call', role: 'follower', call: { callId: 'c1', name: 'click', args: {} }, at: 3 },
        { kind: 'tool.result', role: 'follower', result: { callId: 'c1', name: 'click', ok: true, summary: 'clicked', durationMs: 8 }, at: 4 },
      ]),
    });

    const section = screen.getByText('Step 1').closest('[data-testid="log-section"]');
    expect(section).toBeTruthy();
    expect(within(section as HTMLElement).getByTestId('tool-call-summary')).toBeTruthy();
    expect(within(section as HTMLElement).getByTestId('step-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('the "steps" entry in the Show menu turns per-step grouping into a flat list', async () => {
    const user = userEvent.setup();
    setup({
      log: logOf([
        started,
        { kind: 'step', n: 1, role: 'leader', at: 2 },
        { kind: 'handoff', from: 'leader', to: 'follower', reason: 'go', at: 3 },
      ]),
    });

    // Grouped by default: the step marker itself never renders as its own line — the
    // section header already says "Step 1" — so it does not inflate the entry count.
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(within(screen.getByTestId('run-log')).getAllByTestId('log-entry')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^Show/ }));
    await user.click(screen.getByRole('checkbox', { name: 'steps' }));

    expect(screen.queryByText('Step 1')).toBeNull();
    expect(within(screen.getByTestId('run-log')).getAllByTestId('log-entry')).toHaveLength(2);
    expect(screen.getByTestId('handoff-card')).toBeTruthy();
  });

  it('other Show-menu filters hide entries by kind regardless of grouping', async () => {
    const user = userEvent.setup();
    setup({
      log: logOf([
        started,
        { kind: 'step', n: 1, role: 'leader', at: 2 },
        { kind: 'handoff', from: 'leader', to: 'follower', reason: 'go', at: 3 },
      ]),
    });

    await user.click(screen.getByRole('button', { name: /^Show/ }));
    await user.click(screen.getByRole('checkbox', { name: 'handoffs' }));

    expect(screen.queryByTestId('handoff-card')).toBeNull();
    expect(within(screen.getByTestId('run-log')).getAllByTestId('log-entry')).toHaveLength(1);
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
  it('blocks a second Run while the worker has not acknowledged the first, but still allows Abort', () => {
    setup({ starting: true });
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });
});
