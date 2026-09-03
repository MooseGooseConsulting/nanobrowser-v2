// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { HandoffCard, type HandoffEvent } from './HandoffCard';

afterEach(cleanup);

function handoff(over: Partial<HandoffEvent> = {}): HandoffEvent {
  return {
    kind: 'handoff',
    from: 'follower',
    to: 'leader',
    reason: 'Subgoal finished; the checkout page changed shape.',
    signal: 'SUBGOAL_COMPLETE',
    at: 1_700_000_000_000,
    ...over,
  };
}

describe('HandoffCard', () => {
  it('names both roles, the direction, the reason and the signal', () => {
    render(<HandoffCard event={handoff()} />);
    const card = screen.getByTestId('handoff-card');

    expect(within(card).getByText('Handoff')).toBeTruthy();
    expect(within(card).getByText('Follower')).toBeTruthy();
    expect(within(card).getByText('Leader')).toBeTruthy();
    expect(within(card).getByLabelText('hands control to')).toBeTruthy();
    expect(within(card).getByText('SUBGOAL_COMPLETE')).toBeTruthy();
    expect(within(card).getByText(/checkout page changed shape/)).toBeTruthy();
  });

  it('shows the roles in handoff order, Leader first when the Leader hands off', () => {
    render(<HandoffCard event={handoff({ from: 'leader', to: 'follower', signal: undefined })} />);
    const card = screen.getByTestId('handoff-card');
    const text = card.textContent ?? '';
    expect(text.indexOf('Leader')).toBeLessThan(text.indexOf('Follower'));
    expect(within(card).queryByText('SUBGOAL_COMPLETE')).toBeNull();
  });

  it('is visually distinct from an ordinary entry and flags a BLOCKED signal', () => {
    render(<HandoffCard event={handoff({ signal: 'BLOCKED' })} />);
    const card = screen.getByTestId('handoff-card');
    expect(card.className).toContain('bg-amber-500/10');
    expect(within(card).getByText('BLOCKED').className).toContain('rose');
  });

  it('renders a machine-readable timestamp', () => {
    render(<HandoffCard event={handoff()} />);
    const time = document.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
