// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelInfo } from '@/src/messaging';
import { ModelSelect } from './ModelSelect';

afterEach(cleanup);

function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return { id, name: id, free: false, vision: false, tools: true, contextLength: 128_000, ...over };
}

const MODELS: ModelInfo[] = [
  model('openai/gpt-5', { name: 'GPT-5', vision: true }),
  model('meta/llama-4', { name: 'Llama 4', free: true }),
  model('nvidia/nemotron-ultra', { name: 'NVIDIA Nemotron Ultra', contextLength: 1_000_000 }),
  model('anthropic/claude-opus', { name: 'Claude Opus' }),
];

function optionNames(listbox: HTMLElement): string[] {
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent?.split('·')[0]?.trim() ?? '');
}

describe('ModelSelect', () => {
  it('lists Nemotron first, then free models, then the rest', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="" onChange={() => {}} />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    const names = optionNames(screen.getByRole('listbox', { name: 'Leader model' }));

    expect(names[0]).toContain('NVIDIA Nemotron Ultra');
    expect(names[1]).toContain('Llama 4');
    expect(names.slice(2).join(' ')).toContain('GPT-5');
  });

  it('shows free, vision, tools and context badges', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="" onChange={() => {}} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    const listbox = screen.getByRole('listbox', { name: 'Leader model' });

    expect(within(listbox).getByText('free')).toBeTruthy();
    expect(within(listbox).getByText('vision')).toBeTruthy();
    expect(within(listbox).getAllByText('tools').length).toBeGreaterThan(0);
    expect(within(listbox).getByText(/1M ctx/)).toBeTruthy();
  });

  it('searches the list', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="" onChange={() => {}} />,
    );

    const input = screen.getByRole('combobox', { name: 'Leader model' });
    await user.click(input);
    await user.type(input, 'claude');

    const options = within(screen.getByRole('listbox', { name: 'Leader model' })).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Claude Opus');
  });

  it('reports the chosen model id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="" onChange={onChange} />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Claude Opus/ }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith('anthropic/claude-opus', 'openrouter');
  });

  it('selects with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="" onChange={onChange} />,
    );

    const input = screen.getByRole('combobox', { name: 'Leader model' });
    await user.click(input);
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledExactlyOnceWith('meta/llama-4', 'openrouter');
  });

  it('keeps Leader and Follower selections independent', async () => {
    const user = userEvent.setup();
    const onLeader = vi.fn();
    const onFollower = vi.fn();
    render(
      <>
        <ModelSelect
          id="leader"
          label="Leader model"
          models={MODELS}
          value="nvidia/nemotron-ultra"
          onChange={onLeader}
        />
        <ModelSelect
          id="follower"
          label="Follower model"
          models={MODELS}
          value="meta/llama-4"
          onChange={onFollower}
        />
      </>,
    );

    const leader = screen.getByRole('combobox', { name: 'Leader model' }) as HTMLInputElement;
    const follower = screen.getByRole('combobox', { name: 'Follower model' }) as HTMLInputElement;
    expect(leader.value).toBe('NVIDIA Nemotron Ultra');
    expect(follower.value).toBe('Llama 4');

    await user.click(follower);
    await user.click(screen.getByRole('option', { name: /GPT-5/ }));

    expect(onFollower).toHaveBeenCalledExactlyOnceWith('openai/gpt-5', 'openrouter');
    expect(onLeader).not.toHaveBeenCalled();
    expect(leader.value).toBe('NVIDIA Nemotron Ultra');
  });

  it('says it is waiting when the worker has sent no models', async () => {
    const user = userEvent.setup();
    render(<ModelSelect id="leader" label="Leader model" models={[]} value="" onChange={() => {}} />);

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    expect(screen.getByText('Waiting for worker…')).toBeTruthy();
  });

  it('shows the stored model id even before the catalog loads', () => {
    // Regression: a stored id with no matching catalog entry (the models.list answer
    // has not arrived yet, or the model fell out of the catalog) used to render an
    // empty box, which reads as "my selection was lost" even though storage still
    // holds it (src/ui/state/useConfig.ts never touches it).
    const onChange = vi.fn();
    render(
      <ModelSelect id="leader" label="Leader model" models={[]} value="nvidia/nemotron-ultra" onChange={onChange} />,
    );

    const input = screen.getByRole('combobox', { name: 'Leader model' }) as HTMLInputElement;
    expect(input.value).toBe('nvidia/nemotron-ultra');
    expect(screen.getByText(/waiting for the model list/i)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('flags a stored id that is not in a loaded catalog, distinctly from still-loading', () => {
    render(
      <ModelSelect id="leader" label="Leader model" models={MODELS} value="mistral/ghost" onChange={() => {}} />,
    );
    const input = screen.getByRole('combobox', { name: 'Leader model' }) as HTMLInputElement;
    expect(input.value).toBe('mistral/ghost');
    expect(screen.getByText(/not in the loaded catalog/i)).toBeTruthy();
  });
});

describe('ModelSelect: source (item 4/6 -- Kilo addition)', () => {
  it('shows which source each model came from as a badge', async () => {
    const user = userEvent.setup();
    const models: ModelInfo[] = [
      model('nvidia/nemotron-ultra', { name: 'NVIDIA Nemotron Ultra', source: 'openrouter' }),
      model('meta/muse-spark-1.3-contributor', { name: 'Muse Spark', source: 'kilo' }),
    ];
    render(<ModelSelect id="leader" label="Leader model" models={models} value="" onChange={() => {}} />);
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    const listbox = screen.getByRole('listbox', { name: 'Leader model' });

    expect(within(listbox).getByText('openrouter')).toBeTruthy();
    expect(within(listbox).getByText('kilo')).toBeTruthy();
  });

  it('keeps the same id from two sources as two distinct, independently selectable options', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const models: ModelInfo[] = [
      model('meta/muse-spark-1.3-contributor', { name: 'Muse Spark', source: 'openrouter' }),
      model('meta/muse-spark-1.3-contributor', { name: 'Muse Spark', source: 'kilo', mayTrainOnYourPrompts: false }),
    ];
    render(<ModelSelect id="leader" label="Leader model" models={models} value="" onChange={onChange} />);
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    const listbox = screen.getByRole('listbox', { name: 'Leader model' });
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(2);

    await user.click(options[1]!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('meta/muse-spark-1.3-contributor', 'kilo');
  });

  it('resolves the closed-state display using both the stored id and its stored source', () => {
    const models: ModelInfo[] = [
      model('meta/muse-spark-1.3-contributor', { name: 'Muse Spark (OpenRouter)', source: 'openrouter' }),
      model('meta/muse-spark-1.3-contributor', { name: 'Muse Spark (Kilo)', source: 'kilo' }),
    ];
    render(
      <ModelSelect
        id="leader"
        label="Leader model"
        models={models}
        value="meta/muse-spark-1.3-contributor"
        source="kilo"
        onChange={() => {}}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Leader model' }) as HTMLInputElement;
    expect(input.value).toBe('Muse Spark (Kilo)');
  });

  it('hides models outside the chosen source filter', async () => {
    const user = userEvent.setup();
    const models: ModelInfo[] = [
      model('a/one', { name: 'One', source: 'openrouter' }),
      model('b/two', { name: 'Two', source: 'kilo' }),
    ];
    render(
      <ModelSelect id="leader" label="Leader model" models={models} value="" onChange={() => {}} sourceFilter="kilo" />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    const listbox = screen.getByRole('listbox', { name: 'Leader model' });
    expect(within(listbox).queryByRole('option', { name: /One/ })).toBeNull();
    expect(within(listbox).getByRole('option', { name: /Two/ })).toBeTruthy();
  });
});
