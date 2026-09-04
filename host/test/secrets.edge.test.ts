/**
 * `DopplerSecretProvider` -- the one production credential-lookup
 * implementation (C-06) -- had zero test coverage: every existing test in
 * scope (`dispatcher.test.ts`) only exercises `FakeSecretProvider`. This file
 * mocks `node:child_process` and drives the real class directly: stdout
 * trimming, empty-output -> null, exec error -> null, and the exact args it
 * shells out with (project/config from the env vars it documents reading).
 *
 * `execFile` is called with an argument *array* (never a shell string), so
 * there is no shell-injection surface to test here -- this is a coverage gap,
 * not a security gap in the source itself.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

async function loadSecrets() {
  // Re-imported per test after env vars / mocks are set, since
  // DOPPLER_PROJECT/DOPPLER_CONFIG are read once at module load.
  vi.resetModules();
  return import('../src/secrets.ts');
}

beforeEach(() => {
  execFileMock.mockReset();
  delete process.env.NANOBROWSER_DOPPLER_PROJECT;
  delete process.env.NANOBROWSER_DOPPLER_CONFIG;
});

describe('DopplerSecretProvider.get', () => {
  it('trims and returns stdout on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '  the-secret-value\n'));
    const { DopplerSecretProvider } = await loadSecrets();

    await expect(new DopplerSecretProvider().get('OPENROUTER_API_KEY')).resolves.toBe('the-secret-value');
  });

  it('resolves null when execFile reports an error', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('doppler: not logged in'), ''));
    const { DopplerSecretProvider } = await loadSecrets();

    await expect(new DopplerSecretProvider().get('OPENROUTER_API_KEY')).resolves.toBeNull();
  });

  it('resolves null on empty or whitespace-only stdout, without treating it as an error', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '   \n  '));
    const { DopplerSecretProvider } = await loadSecrets();

    await expect(new DopplerSecretProvider().get('OPENROUTER_API_KEY')).resolves.toBeNull();
  });

  it('shells out to doppler with the secret name and the project/config from env, as an argument array', async () => {
    process.env.NANOBROWSER_DOPPLER_PROJECT = 'my-project';
    process.env.NANOBROWSER_DOPPLER_CONFIG = 'prod';
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'v'));
    const { DopplerSecretProvider } = await loadSecrets();

    await new DopplerSecretProvider().get('OPENROUTER_API_KEY');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('doppler');
    expect(args).toEqual(['secrets', 'get', 'OPENROUTER_API_KEY', '--plain', '-p', 'my-project', '-c', 'prod']);
    expect(opts).toMatchObject({ timeout: 20_000 });
  });

  it('defaults project/config when the env vars are unset', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'v'));
    const { DopplerSecretProvider } = await loadSecrets();

    await new DopplerSecretProvider().get('OPENROUTER_API_KEY');

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['secrets', 'get', 'OPENROUTER_API_KEY', '--plain', '-p', 'ai-automation', '-c', 'dev']);
  });

  it('reports its own name as "doppler"', async () => {
    const { DopplerSecretProvider } = await loadSecrets();
    expect(new DopplerSecretProvider().name).toBe('doppler');
  });
});
