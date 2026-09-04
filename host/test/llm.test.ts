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

describe('modelsAll payload size', () => {
  it("keeps two merged catalogs under Chrome's 1 MiB host->extension cap", async () => {
    // Regression: forwarding both catalogs verbatim produced a 1167174-byte message
    // and the host logged "failed to encode outbound message", so the panel's model
    // list simply never arrived. Each raw entry carries a description paragraph the
    // extension's mapper never reads.
    const bulky = (n: number, prefix: string) => ({
      data: Array.from({ length: n }, (_, i) => ({
        id: `${prefix}/model-${i}`,
        name: `Model ${i}`,
        description: 'x'.repeat(1200),
        context_length: 128000,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools'],
        architecture: { input_modalities: ['text'], tokenizer: 'y'.repeat(200) },
        isFree: true,
      })),
    });

    h = await makeHarness({ key: 'or-secret', kiloKey: 'kilo-secret' });
    h.fetch.enqueueJson(200, bulky(400, 'or'));
    h.fetch.enqueueJson(200, bulky(400, 'kilo'));

    await h.dispatcher.handle({ type: 'models.list', id: 'm1' });

    const reply = h.sent.find((m) => m.type === 'models.list.result');
    expect(reply).toBeDefined();
    const bytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
    expect(bytes).toBeLessThan(1024 * 1024);
    // The mapper's fields survive; the paragraph does not.
    const json = JSON.stringify(reply);
    expect(json).toContain('context_length');
    expect(json).not.toContain('xxxxxxxxxx');
  });
});
