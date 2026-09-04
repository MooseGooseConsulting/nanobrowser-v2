// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberField, isValidInt } from './NumberField';

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof NumberField>[0]> = {}) {
  const onChange = vi.fn();
  render(<NumberField id="n" value={5} min={1} max={10} onChange={onChange} {...overrides} />);
  return { onChange, input: screen.getByRole('spinbutton') as HTMLInputElement };
}

describe('NumberField', () => {
  it('commits a valid number as it is typed', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.clear(input);
    await user.type(input, '7');
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  // Regression: an empty `<input type=number>` reports `valueAsNumber: NaN`, and the old
  // implementation passed that straight through, so clearing the field wrote NaN into the
  // stored Config -- contradicting this component's own "never committed" promise.
  it('shows an emptied field as invalid without committing anything', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.clear(input);

    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('whole number from 1 to 10');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an out-of-range number but does not commit it', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.clear(input);
    await user.type(input, '99');

    expect(input.value).toBe('99');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalledWith(99);
  });

  it('lets the user clear and retype without the field snapping back mid-edit', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.clear(input);
    await user.type(input, '1');
    // '1' is valid and committed; the draft must still read what was typed, not the old 5.
    expect(input.value).toBe('1');
  });

  it('takes a committed change from elsewhere over whatever is in the field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<NumberField id="n" value={5} min={1} max={10} onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    await user.clear(input);
    expect(input.value).toBe('');

    // e.g. Reset in Setup, or config arriving from storage.
    rerender(<NumberField id="n" value={3} min={1} max={10} onChange={onChange} />);
    expect(input.value).toBe('3');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('uses a caller-supplied message instead of the default one', async () => {
    const user = userEvent.setup();
    const { input } = setup({ invalidMessage: 'pick a step budget' });

    await user.clear(input);
    expect(screen.getByRole('alert').textContent).toBe('pick a step budget');
  });
});

describe('isValidInt', () => {
  it('accepts whole numbers inside the range and rejects everything else', () => {
    expect(isValidInt(5, 1, 10)).toBe(true);
    expect(isValidInt(1, 1, 10)).toBe(true);
    expect(isValidInt(10, 1, 10)).toBe(true);
    expect(isValidInt(0, 1, 10)).toBe(false);
    expect(isValidInt(11, 1, 10)).toBe(false);
    expect(isValidInt(5.5, 1, 10)).toBe(false);
    expect(isValidInt(Number.NaN, 1, 10)).toBe(false);
  });
});
