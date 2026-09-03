/**
 * Model handles for the graph.
 *
 * `createChatModel` builds a `ChatOpenAI` pointed at an OpenRouter-shaped
 * endpoint. The extension never holds the user's key (R-12): the `fetch` passed
 * in belongs to the host proxy, which attaches the real credential on its way
 * out. `apiKey` here is a non-secret placeholder only because the underlying
 * openai client refuses to construct without one.
 *
 * `provider.data_collection` is "deny" for paid models because page DOM and
 * screenshots are sent on every step (docs/research/models-and-grounding.md §6).
 * OpenRouter's `:free` endpoints exist only under the training data policy, so
 * "deny" yields `404 No endpoints found matching your data policy`; the user
 * chose free models knowingly (see the live run in docs/STATUS.md), so those
 * get "allow".
 */
export function dataCollectionFor(model: string): 'allow' | 'deny' {
  return model.endsWith(':free') ? 'allow' : 'deny';
}
import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';

/** Sentinel key. The real credential is added by the host proxy behind `fetch` (R-12). */
export const PROXY_MANAGED_KEY = 'host-proxy-managed';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateChatModelOptions {
  /** OpenRouter model id, e.g. "nvidia/nemotron-3.5-lightning:free". */
  model: string;
  /** The host proxy's fetch. Every request goes through it; it holds the key. */
  fetch: typeof globalThis.fetch;
  baseURL?: string;
  temperature?: number;
}

export function createChatModel(options: CreateChatModelOptions): ChatOpenAI {
  const { model, fetch, baseURL = DEFAULT_BASE_URL, temperature = 0 } = options;
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: PROXY_MANAGED_KEY,
    configuration: { baseURL, fetch },
    modelKwargs: {
      provider: { data_collection: dataCollectionFor(model), allow_fallbacks: true },
    },
  });
}

/* ------------------------------------------------------------------------- */
/* Test double                                                               */
/* ------------------------------------------------------------------------- */

/** One scripted model turn: plain text, or a single tool call. */
export type FakeTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; text?: string };

export interface FakeCall {
  /** Zero-based index of this call on this model instance. */
  index: number;
  messages: BaseMessage[];
  /** Names of the tools bound at the time of the call. */
  tools: string[];
}

export interface FakeChatModelInit extends BaseChatModelParams {
  /** Turns played in order. The last one repeats once the list is exhausted. */
  turns?: FakeTurn[];
  /** Takes precedence over `turns` when present. */
  respond?: (call: FakeCall) => FakeTurn;
  label?: string;
}

/**
 * A `BaseChatModel` that never touches the network.
 *
 * Supports `bindTools` and scripts the Follower's structured signal by putting it
 * in the tool-call arguments, exactly where a real tool-calling model puts it.
 */
export class FakeChatModel extends BaseChatModel {
  /** Every call this instance received, in order. Assert history separation on it. */
  readonly calls: FakeCall[] = [];

  readonly label: string;

  #turns: FakeTurn[];
  #respond?: (call: FakeCall) => FakeTurn;
  #boundTools: string[] = [];
  #toolCallSeq = 0;

  constructor(init: FakeChatModelInit = {}) {
    super(init);
    this.#turns = init.turns ?? [{ kind: 'text', text: 'ok' }];
    this.#respond = init.respond;
    this.label = init.label ?? 'fake';
  }

  _llmType(): string {
    return 'fake';
  }

  override bindTools(
    tools: BindToolsInput[],
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, this['ParsedCallOptions']> {
    this.#boundTools = tools.map((t) =>
      typeof t === 'object' && t !== null && 'name' in t ? String(t.name) : 'unknown',
    );
    // The fake answers directly; nothing downstream needs a distinct bound object.
    return this as unknown as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk,
      this['ParsedCallOptions']
    >;
  }

  /** The tool names most recently bound. */
  get boundTools(): string[] {
    return [...this.#boundTools];
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const call: FakeCall = {
      index: this.calls.length,
      messages,
      tools: [...this.#boundTools],
    };
    this.calls.push(call);

    const turn =
      this.#respond?.(call) ??
      this.#turns[Math.min(call.index, this.#turns.length - 1)] ??
      ({ kind: 'text', text: 'ok' } satisfies FakeTurn);

    if (turn.kind === 'text') {
      const message = new AIMessage({ content: turn.text });
      return { generations: [{ text: turn.text, message }] };
    }

    this.#toolCallSeq += 1;
    const text = turn.text ?? '';
    const message = new AIMessage({
      content: text,
      tool_calls: [
        {
          id: `${this.label}-call-${this.#toolCallSeq}`,
          name: turn.name,
          args: turn.args,
          type: 'tool_call',
        },
      ],
    });
    return { generations: [{ text, message }] };
  }
}
