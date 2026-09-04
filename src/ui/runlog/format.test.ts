import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsed, summarizeArgs } from './format';

describe('formatElapsed', () => {
  it('renders sub-minute deltas as +Ns.d', () => {
    expect(formatElapsed(12_400)).toBe('+12.4s');
    expect(formatElapsed(0)).toBe('+0.0s');
  });

  it('switches to minutes past a minute', () => {
    expect(formatElapsed(64_000)).toBe('+1m04s');
    expect(formatElapsed(125_000)).toBe('+2m05s');
  });

  it('still renders a negative delta rather than throwing', () => {
    expect(formatElapsed(-500)).toBe('-0.5s');
  });
});

describe('formatDuration', () => {
  it('renders sub-second durations in ms', () => {
    expect(formatDuration(240)).toBe('240ms');
  });

  it('renders longer durations in seconds', () => {
    expect(formatDuration(1_240)).toBe('1.24s');
  });
});

describe('summarizeArgs', () => {
  it('is undefined for no args, or non-object args', () => {
    expect(summarizeArgs(undefined)).toBeUndefined();
    expect(summarizeArgs(null)).toBeUndefined();
    expect(summarizeArgs('x')).toBeUndefined();
    expect(summarizeArgs({})).toBeUndefined();
  });

  it('renders key=value pairs from an object', () => {
    expect(summarizeArgs({ selector: '#buy' })).toBe('selector=#buy');
  });

  it('truncates a long preview', () => {
    const long = summarizeArgs({ text: 'x'.repeat(80) }, 20);
    expect(long?.length).toBeLessThanOrEqual(21);
    expect(long?.endsWith('…')).toBe(true);
  });
});
