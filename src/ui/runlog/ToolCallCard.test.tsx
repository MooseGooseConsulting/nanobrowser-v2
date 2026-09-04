// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunEvent } from '@/src/messaging';
import type { ToolEntry } from '../state/runlog';
import { ToolCallCard } from './ToolCallCard';

afterEach(cleanup);

const ARGS = { selector: '#buy', text: 'Buy now', nested: { retries: 2 } };

const call: Extract<RunEvent, { kind: 'tool.call' }> = {
  kind: 'tool.call',
  role: 'follower',
  call: { callId: 'c-1', name: 'click_element', args: ARGS },
  at: 1_700_000_000_000,
};

const result: Extract<RunEvent, { kind: 'tool.result' }> = {
  kind: 'tool.result',
  role: 'follower',
  result: {
    callId: 'c-1',
    name: 'click_element',
    ok: true,
    summary: 'Clicked "Buy now".',
    durationMs: 1_240,
  },
  at: 1_700_000_001_240,
};

const entry = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  key: 'tool:c-1',
  callId: 'c-1',
  call,
  result,
  ...over,
});

describe('ToolCallCard', () => {
  it('starts collapsed, showing name, outcome and duration only', () => {
    render(<ToolCallCard entry={entry()} />);

    const summary = screen.getByTestId('tool-call-summary');
    expect(summary.textContent).toContain('click_element');
    expect(summary.textContent).toContain('ok');
    expect(summary.textContent).toContain('1.24s');
    // Requirement 4: "name, key args, ok/error, duration" — a glance at the args
    // without expanding the card.
    expect(summary.textContent).toContain('selector=#buy');

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('tool-call-args')).toBeNull();
  });

  it('expands on click and pretty-prints the arguments', async () => {
    const user = userEvent.setup();
    render(<ToolCallCard entry={entry()} />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('tool-call-args').textContent).toBe(JSON.stringify(ARGS, null, 2));
    expect(screen.getByTestId('tool-call-result').textContent).toBe('Clicked "Buy now".');
  });

  it('expands from the keyboard', async () => {
    const user = userEvent.setup();
    render(<ToolCallCard entry={entry()} />);

    await user.tab();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('marks a failed call', () => {
    render(
      <ToolCallCard
        entry={entry({
          result: { ...result, result: { ...result.result, ok: false, summary: 'element not found' } },
        })}
      />,
    );
    expect(screen.getByTestId('tool-call-summary').textContent).toContain('fail');
  });

  it('shows a call still awaiting its result', async () => {
    const user = userEvent.setup();
    render(<ToolCallCard entry={entry({ result: undefined })} />);

    expect(screen.getByTestId('tool-call-summary').textContent).toContain('running');
    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('tool-call-result').textContent).toContain('waiting for the tool');
  });

  it('renders an orphan result without its call', async () => {
    const user = userEvent.setup();
    render(<ToolCallCard entry={entry({ call: undefined })} />);

    expect(screen.getByTestId('tool-call-summary').textContent).toContain('click_element');
    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('tool-call-args').textContent).toContain('call not received');
  });
});
