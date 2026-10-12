import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createChatModel } from '@/src/agent/models';

const completion = () =>
  new Response(
    JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion',
      created: 0,
      model: 'x/y:free',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A gateway that rate-limits the first `n` requests, the way OpenRouter's free tier does. */
function limitedFor(n: number, as: 'status' | 'body') {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    if (calls > n) return completion();
    return as === 'status'
      ? new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429 } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      : new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  };
  return { fetch, calls: () => calls };
}

describe('free-tier rate limits', () => {
  it.each(['status', 'body'] as const)('a 429 (as %s) is retried until the provider answers, not returned as the result', async (as) => {
    const gw = limitedFor(2, as);
    const model = createChatModel({ model: 'x/y:free', fetch: gw.fetch, rateLimitDelaysMs: [1, 1, 1] });
    const reply = await model.invoke([new HumanMessage('hi')]);
    expect(reply.content).toBe('ok');
    expect(gw.calls()).toBe(3);
  }, 30_000);

  it('gives up after the last wait and reports the 429, rather than retrying forever', async () => {
    // Codeant flagged that ChatOpenAI might retry the wrapper-returned 429 up to four
    // more times, multiplying these calls. It does not: the OpenAI SDK client is
    // built with maxRetries: 0 (ChatOpenAI does its own retrying through LangChain's
    // AsyncCaller), and @langchain/core 1.2.12 classifies a headerless 429 as
    // capacity and ends the call on it. The exact 3 is the pin.
    const gw = limitedFor(99, 'body');
    const model = createChatModel({ model: 'x/y:free', fetch: gw.fetch, rateLimitDelaysMs: [1, 1] });
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow(/429/);
    expect(gw.calls()).toBe(3);
  });
});
