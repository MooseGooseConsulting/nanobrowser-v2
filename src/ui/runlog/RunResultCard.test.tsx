// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunEvent } from '@/src/messaging';
import { RunResultCard } from './RunResultCard';

afterEach(cleanup);

const CONFIG = {
  leaderModel: 'a',
  followerModel: 'b',
  observe: 'dom' as const,
  planningInterval: 5,
  maxSteps: 50,
  inputFidelity: 'in-page' as const,
};

const started: RunEvent = {
  kind: 'run.started',
  runId: 'run-1',
  prompt: 'buy the thing',
  config: CONFIG,
  tabId: 1,
  url: 'https://example.com',
  at: 1_000,
};

describe('RunResultCard', () => {
  it('renders nothing before the run ends', () => {
    render(<RunResultCard events={[started]} />);
    expect(screen.queryByTestId('run-result-card')).toBeNull();
  });

  it('shows outcome, summary, steps and elapsed time', () => {
    render(
      <RunResultCard
        events={[started, { kind: 'run.ended', status: 'done', message: 'Found the three threads.', steps: 4, at: 13_400 }]}
      />,
    );
    const card = screen.getByTestId('run-result-card');
    expect(card.textContent).toContain('Done');
    expect(card.textContent).toContain('4 steps');
    expect(card.textContent).toContain('12.4s');
    expect(screen.getByTestId('run-result-message').textContent).toBe('Found the three threads.');
  });

  it('collapses a long summary behind show more', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(300);
    render(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'error', message: long, steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-message').textContent).not.toBe(long);
    await user.click(screen.getByRole('button', { name: 'show more' }));
    expect(screen.getByTestId('run-result-message').textContent).toBe(long);
  });

  it('lists saved files read generically off the event stream (TODO: file.saved)', () => {
    const events = [
      started,
      { kind: 'file.saved', name: 'report.pdf', url: 'blob:report' } as unknown as RunEvent,
      { kind: 'run.ended', status: 'done', message: 'done', steps: 1, at: 2_000 } as RunEvent,
    ];
    render(<RunResultCard events={events} />);
    const files = screen.getByTestId('run-result-files');
    expect(files.textContent).toContain('report.pdf');
    expect(screen.getByRole('link', { name: 'report.pdf' }).getAttribute('href')).toBe('blob:report');
  });

  it('names the outcome for blocked, aborted and max-steps too', () => {
    const { rerender } = render(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'blocked', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Blocked');

    rerender(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'aborted', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Aborted');

    rerender(
      <RunResultCard events={[started, { kind: 'run.ended', status: 'max-steps', message: '', steps: 1, at: 2_000 }]} />,
    );
    expect(screen.getByTestId('run-result-card').textContent).toContain('Max steps reached');
  });
});
