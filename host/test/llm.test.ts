/**
 * `resolveUrl` and `LlmProxy.request`'s credential selection (host/src/llm.ts):
 * the security seam for item 2 of the Kilo addition. `dispatcher.test.ts` covers
 * the OpenRouter path end to end already; this covers Kilo routing and the
 * cross-source refusal directly, and proves the wrong key is never attached.
 */
import { describe, expect, it } from 'vitest';
import { resolveUrl } from '../src/llm.ts';
import { makeHarness, utf8, type Harness } from './harness.ts';

let h: Harness;

describe('resolveUrl', () => {
  it('routes a Kilo absolute url to the Kilo base and tags its source', () => {
    expect(resolveUrl('https://api.kilo.ai/api/gateway/chat/completions')).toEqual({
      url: 'https://api.kilo.ai/api/gateway/chat/completions',
      source: 'kilo',
    });
  });

  it('still defaults a relative path to OpenRouter, unchanged from before Kilo existed', () => {
    expect(resolveUrl('/chat/completions')).toEqual({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      source: 'openrouter',
    });
  });

  it('throws rather than resolving an unrecognised origin', () => {
    expect(() => resolveUrl('https://evil.example.com/steal')).toThrow();
  });
});

describe('llm.request: credential selection by URL origin', () => {
  it('attaches the Kilo key, not the OpenRouter key, for a Kilo request', async () => {
    h = await makeHarness({ key: 'or-secret', kiloKey: 'kilo-secret' });
    h.fetch.enqueueStream(200, [utf8('ok')]);
    await h.dispatcher.handle({
      type: 'llm.request',
      id: 'r1',
      url: 'https://api.kilo.ai/api/gateway/chat/completions',
      body: { model: 'meta/muse-spark-1.3-contributor', messages: [] },
    });

    const call = h.fetch.calls[0]!;
    expect(call.url).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect(call.headers['authorization']).toBe('Bearer kilo-secret');
    expect(call.headers['authorization']).not.toBe('Bearer or-secret');
    await h.cleanup();
  });

  it('never attaches a key to an origin the host does not recognise', async () => {
    h = await makeHarness({ key: 'or-secret', kiloKey: 'kilo-secret' });
    await h.dispatcher.handle({
      type: 'llm.request',
      id: 'r1',
      url: 'https://evil.example.com/steal',
      body: { model: 'x', messages: [] },
    });

    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', id: 'r1', code: 'bad_request' });
    await h.cleanup();
  });

  it('reports no_key for Kilo specifically when only the OpenRouter key is loaded', async () => {
    h = await makeHarness({ key: 'or-secret', kiloKey: null });
    await h.dispatcher.handle({
      type: 'llm.request',
      id: 'r1',
      url: 'https://api.kilo.ai/api/gateway/chat/completions',
      body: { model: 'x', messages: [] },
    });

    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', id: 'r1', code: 'no_key' });
    expect((h.sent[0] as { message: string }).message).toContain('KILO_CODE_API_KEY');
    await h.cleanup();
  });
});
