import { execFile } from 'node:child_process';
import { protectSecret } from './log.ts';

/**
 * One narrow seam for credential lookup (C-06: Doppler now, OpenBao or the OS
 * keychain later). Swapping the backend must never touch the protocol or the
 * extension. Values are held in process memory only -- never written, logged or
 * echoed anywhere.
 */
export interface SecretProvider {
  readonly name: string;
  get(name: string): Promise<string | null>;
}

const DOPPLER_PROJECT = process.env.NANOBROWSER_DOPPLER_PROJECT || 'ai-automation';
const DOPPLER_CONFIG = process.env.NANOBROWSER_DOPPLER_CONFIG || 'dev';

export class DopplerSecretProvider implements SecretProvider {
  readonly name = 'doppler';

  get(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'doppler',
        ['secrets', 'get', name, '--plain', '-p', DOPPLER_PROJECT, '-c', DOPPLER_CONFIG],
        { timeout: 20_000, maxBuffer: 1 << 20, env: process.env },
        (err, stdout) => {
          // stderr is deliberately dropped: doppler echoes context we do not need
          // and we will not risk relaying anything secret-shaped into the log.
          if (err) return resolve(null);
          const value = String(stdout).trim();
          resolve(value.length > 0 ? value : null);
        },
      );
    });
  }
}

/** Test double. Never reaches the network or a real store. */
export class FakeSecretProvider implements SecretProvider {
  readonly name = 'fake';
  readonly #values: Record<string, string | null>;

  constructor(values: Record<string, string | null>) {
    this.#values = values;
  }

  async get(name: string): Promise<string | null> {
    return this.#values[name] ?? null;
  }
}

export class SecretStore {
  #key: string | null = null;
  #reason: string | undefined;

  readonly #provider: SecretProvider;

  constructor(provider: SecretProvider) {
    this.#provider = provider;
  }

  async load(): Promise<void> {
    const key = await this.#provider.get('OPENROUTER_API_KEY');
    if (!key) {
      this.#reason = `OPENROUTER_API_KEY not available from ${this.#provider.name}`;
      return;
    }
    this.#key = key;
    protectSecret(key);
    this.#reason = undefined;
  }

  /** The key itself. Callers must only put it in an outbound Authorization header. */
  get openRouterKey(): string | null {
    return this.#key;
  }

  get missingReason(): string | undefined {
    return this.#reason;
  }
}
