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

/** The two credentialed model sources (docs/host-protocol.md). Add here, not as a third seam. */
export type SecretSource = 'openrouter' | 'kilo';

const SECRET_ENV_NAMES: Record<SecretSource, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  kilo: 'KILO_CODE_API_KEY',
};

interface SourceState {
  key: string | null;
  reason?: string;
}

function emptyState(): SourceState {
  return { key: null };
}

/**
 * Holds one credential per source. Loading both is independent: a Kilo key being
 * absent must not stop OpenRouter from working and vice versa (neither missing
 * secret may crash the host), so `load()` fetches them in parallel and each
 * source keeps its own present/absent state and its own reason when absent.
 */
export class SecretStore {
  #state: Record<SecretSource, SourceState> = { openrouter: emptyState(), kilo: emptyState() };

  readonly #provider: SecretProvider;

  constructor(provider: SecretProvider) {
    this.#provider = provider;
  }

  async load(): Promise<void> {
    await Promise.all((Object.keys(SECRET_ENV_NAMES) as SecretSource[]).map((source) => this.#loadSource(source)));
  }

  async #loadSource(source: SecretSource): Promise<void> {
    const envName = SECRET_ENV_NAMES[source];
    const key = await this.#provider.get(envName);
    if (!key) {
      this.#state[source] = { key: null, reason: `${envName} not available from ${this.#provider.name}` };
      return;
    }
    protectSecret(key);
    this.#state[source] = { key };
  }

  /** The key for one source. Callers must only put it in an outbound Authorization header. */
  key(source: SecretSource): string | null {
    return this.#state[source].key;
  }

  /** Per-source readiness (R-11 pattern applied to credentials, C-06): loaded or not, and why not. */
  status(source: SecretSource): { ready: boolean; reason?: string } {
    const state = this.#state[source];
    return state.key ? { ready: true } : { ready: false, ...(state.reason ? { reason: state.reason } : {}) };
  }

  /**
   * Back-compat single-source accessors from before Kilo existed. `llm.ts`'s wire-level
   * `key.status` message still validates OpenRouter specifically (a live `GET /key`), so
   * these keep that call site unchanged.
   */
  get openRouterKey(): string | null {
    return this.key('openrouter');
  }

  get missingReason(): string | undefined {
    return this.#state.openrouter.reason;
  }
}
