/**
 * `SecretStore` itself (not `DopplerSecretProvider`, covered by
 * `secrets.edge.test.ts`): loading two independent credentials in parallel,
 * neither one's absence crashing the other, and per-source readiness (C-06,
 * the Kilo addition to host/src/secrets.ts).
 */
import { describe, expect, it } from 'vitest';
import { FakeSecretProvider, SecretStore } from '../src/secrets.ts';

describe('SecretStore.load with both sources present', () => {
  it('loads OpenRouter and Kilo independently and reports both ready', async () => {
    const store = new SecretStore(
      new FakeSecretProvider({ OPENROUTER_API_KEY: 'or-key', KILO_CODE_API_KEY: 'kilo-key' }),
    );
    await store.load();

    expect(store.key('openrouter')).toBe('or-key');
    expect(store.key('kilo')).toBe('kilo-key');
    expect(store.status('openrouter')).toEqual({ ready: true });
    expect(store.status('kilo')).toEqual({ ready: true });
  });
});

describe('SecretStore.load with one source missing', () => {
  it('does not crash when only OPENROUTER_API_KEY is absent, and still loads Kilo', async () => {
    const store = new SecretStore(new FakeSecretProvider({ KILO_CODE_API_KEY: 'kilo-key' }));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.key('openrouter')).toBeNull();
    expect(store.status('openrouter')).toMatchObject({ ready: false });
    expect(store.status('openrouter').reason).toContain('OPENROUTER_API_KEY');
    expect(store.key('kilo')).toBe('kilo-key');
    expect(store.status('kilo')).toEqual({ ready: true });
  });

  it('does not crash when only KILO_CODE_API_KEY is absent, and still loads OpenRouter', async () => {
    const store = new SecretStore(new FakeSecretProvider({ OPENROUTER_API_KEY: 'or-key' }));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.key('kilo')).toBeNull();
    expect(store.status('kilo').reason).toContain('KILO_CODE_API_KEY');
    expect(store.key('openrouter')).toBe('or-key');
  });

  it('does not crash when neither key is available', async () => {
    const store = new SecretStore(new FakeSecretProvider({}));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.status('openrouter').ready).toBe(false);
    expect(store.status('kilo').ready).toBe(false);
  });
});

describe('SecretStore back-compat single-source accessors', () => {
  it('openRouterKey and missingReason mirror the openrouter source (pre-Kilo call sites)', async () => {
    const store = new SecretStore(new FakeSecretProvider({}));
    await store.load();
    expect(store.openRouterKey).toBeNull();
    expect(store.missingReason).toContain('OPENROUTER_API_KEY');
  });
});
