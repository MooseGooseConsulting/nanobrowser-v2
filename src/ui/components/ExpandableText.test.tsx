// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpandableText } from './ExpandableText';

afterEach(cleanup);

describe('ExpandableText', () => {
  it('renders short text with no control at all', () => {
    render(<ExpandableText text="short" />);
    expect(screen.getByText('short')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('truncates long text behind a "show more" toggle', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(300);
    render(<ExpandableText text={long} limit={240} />);

    expect(screen.getByText((content) => content.endsWith('…')).textContent?.length).toBeLessThan(300);
    await user.click(screen.getByRole('button', { name: 'show more' }));
    expect(screen.getByText(long)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'show less' }));
    expect(screen.queryByText(long)).toBeNull();
  });
});
