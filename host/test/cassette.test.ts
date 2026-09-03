import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CassetteStore,
  cassetteKey,
  cassetteMode,
  normalizePath,
  OffOriginError,
  stableStringify,
} from '../src/cassette.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-cassettes-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const req = (over: Record<string, unknown> = {}) => ({
  url: '/chat/completions',
  body: { model: 'nvidia/nemotron-3.5-lightning:free', messages: [{ role: 'user', content: 'hi' }], ...over },
});

describe('cassette key', () => {
  it('is a sha256 hex digest', () => {
    expect(cassetteKey(req())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order in the body', () => {
    const a = cassetteKey({
      url: '/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    });
    const b = cassetteKey({
      url: '/chat/completions',
      body: { messages: [{ content: 'hi', role: 'user' }], model: 'm' },
    });
    expect(a).toBe(b);
  });

  it('ignores parameters outside (url, model, messages)', () => {
    expect(cassetteKey(req({ temperature: 0.7, stream: true }))).toBe(cassetteKey(req()));
  });

  it('changes with the model', () => {
    expect(cassetteKey(req({ model: 'other' }))).not.toBe(cassetteKey(req()));
  });

  it('changes with the messages', () => {
    expect(cassetteKey(req({ messages: [{ role: 'user', content: 'bye' }] }))).not.toBe(cassetteKey(req()));
  });

  it('changes with the url path', () => {
    expect(cassetteKey({ ...req(), url: '/completions' })).not.toBe(cassetteKey(req()));
  });

  it('normalizes equivalent url spellings to one key', () => {
    expect(cassetteKey({ ...req(), url: 'chat/completions' })).toBe(cassetteKey(req()));
    expect(cassetteKey({ ...req(), url: '/chat/completions/' })).toBe(cassetteKey(req()));
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('normalizePath', () => {
  it.each([
    ['/chat/completions', 'chat/completions'],
    ['chat/completions', 'chat/completions'],
    ['/chat/completions//', 'chat/completions'],
    ['https://openrouter.ai/api/v1/key', 'key'],
    ['https://openrouter.ai/api/v1/chat/completions?x=1', 'chat/completions?x=1'],
  ])('%s -> %s', (input, want) => {
    expect(normalizePath(input)).toBe(want);
  });
});

describe('normalizePath off-origin', () => {
  it('throws rather than silently rewriting a foreign origin', () => {
    expect(() => normalizePath('https://evil.example.com/steal')).toThrow(OffOriginError);
    expect(() => normalizePath('//evil.example.com/steal')).toThrow(OffOriginError);
  });
});

describe('cassetteMode', () => {
  it('is off unless explicitly record or replay', () => {
    expect(cassetteMode({})).toBe('off');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: '1' })).toBe('off');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: 'record' })).toBe('record');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: 'replay' })).toBe('replay');
  });
});

describe('CassetteStore', () => {
  it('writes and reads an entry by key', async () => {
    const store = new CassetteStore(dir);
    const key = cassetteKey(req());
    await store.write({
      key,
      url: 'chat/completions',
      model: 'm',
      status: 200,
      headers: { a: 'b' },
      chunks: ['aGk='],
    });
    expect(await store.read(key)).toEqual({
      key,
      url: 'chat/completions',
      model: 'm',
      status: 200,
      headers: { a: 'b' },
      chunks: ['aGk='],
    });
  });

  it('returns null for a miss', async () => {
    expect(await new CassetteStore(dir).read('deadbeef')).toBeNull();
  });
});
