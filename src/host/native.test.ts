import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativePort,
  HostClient,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  mapOpenRouterModel,
  type HostRequestMsg,
} from './native';

function makeClient() {
  const ports: FakeNativePort[] = [];
  const factory = () => {
    const port = new FakeNativePort();
    ports.push(port);
    return port;
  };
  return { client: new HostClient(factory), ports };
}

function lastSent(port: FakeNativePort): HostRequestMsg & { id: string } {
  const msg = port.sent[port.sent.length - 1];
  if (!msg || typeof (msg as { id?: unknown }).id !== 'string') throw new Error('nothing sent with an id');
  return msg as HostRequestMsg & { id: string };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('correlator', () => {
  it('round-trips key.status', async () => {
    const { client, ports } = makeClient();
    const promise = client.keyStatus();
    const port = ports[0]!;
    const sent = lastSent(port);
    expect(sent.type).toBe('key.status');
    port.emit({ type: 'key.status.result', id: sent.id, ready: true });
    await expect(promise).resolves.toEqual({ hostConnected: true, keyReady: true });
  });

  it('round-trips models.list', async () => {
    const { client, ports } = makeClient();
    const promise = client.listModels();
    const port = ports[0]!;
    const sent = lastSent(port);
    expect(sent.type).toBe('models.list');
    port.emit({ type: 'models.list.result', id: sent.id, status: 200, body: { data: [] } });
    await expect(promise).resolves.toEqual([]);
  });

  it('rejects the pending call on a generic error reply', async () => {
    const { client, ports } = makeClient();
    const promise = client.listModels();
    const sent = lastSent(ports[0]!);
    ports[0]!.emit({ type: 'error', id: sent.id, code: 'upstream', message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('does not cross-resolve two concurrent calls', async () => {
    const { client, ports } = makeClient();
    const keyPromise = client.keyStatus();
    const modelsPromise = client.listModels();
    const port = ports[0]!;
    const [keyMsg, modelsMsg] = port.sent as Array<HostRequestMsg & { id: string }>;
    port.emit({ type: 'models.list.result', id: modelsMsg!.id, status: 200, body: { data: [] } });
    port.emit({ type: 'key.status.result', id: keyMsg!.id, ready: true });
    await expect(keyPromise).resolves.toEqual({ hostConnected: true, keyReady: true });
    await expect(modelsPromise).resolves.toEqual([]);
  });
});

describe('keyStatus mapping', () => {
  it('maps ready:false with a reason', async () => {
    const { client, ports } = makeClient();
    const promise = client.keyStatus();
    const sent = lastSent(ports[0]!);
    ports[0]!.emit({ type: 'key.status.result', id: sent.id, ready: false, reason: 'no key loaded' });
    await expect(promise).resolves.toEqual({ hostConnected: true, keyReady: false, reason: 'no key loaded' });
  });

  it('reports hostConnected:false when the port disconnects before a reply', async () => {
    const { client, ports } = makeClient();
    const promise = client.keyStatus();
    ports[0]!.disconnect();
    const result = await promise;
    expect(result.hostConnected).toBe(false);
    expect(result.keyReady).toBe(false);
  });
});

describe('listModels mapping', () => {
  const SAMPLE = [
    {
      id: 'nvidia/nemotron-3.5-lightning:free',
      name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
      context_length: 1_000_000,
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      name: 'NVIDIA: Nemotron 3 Nano Omni 30B A3B (reasoning) (free)',
      context_length: 256_000,
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text', 'image', 'audio', 'video'] },
      supported_parameters: ['tools'],
    },
    {
      id: 'qwen/qwen3-vl-8b-instruct',
      name: 'Qwen: Qwen3 VL 8B Instruct',
      context_length: 131_072,
      pricing: { prompt: '0.000000117', completion: '0.000000455' },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['tools'],
    },
    {
      id: 'mistralai/mistral-nemo',
      name: 'Mistral: Mistral Nemo',
      context_length: 131_072,
      pricing: { prompt: '0.000000019', completion: '0.00000003' },
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['structured_outputs'],
    },
  ];

  it('maps free/vision/tools/contextLength for each catalog shape', () => {
    expect(SAMPLE.map((m) => mapOpenRouterModel(m))).toEqual([
      {
        id: 'nvidia/nemotron-3.5-lightning:free',
        name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
        free: true,
        vision: false,
        tools: true,
        contextLength: 1_000_000,
      },
      {
        id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        name: 'NVIDIA: Nemotron 3 Nano Omni 30B A3B (reasoning) (free)',
        free: true,
        vision: true,
        tools: true,
        contextLength: 256_000,
      },
      {
        id: 'qwen/qwen3-vl-8b-instruct',
        name: 'Qwen: Qwen3 VL 8B Instruct',
        free: false,
        vision: true,
        tools: true,
        contextLength: 131_072,
      },
      {
        id: 'mistralai/mistral-nemo',
        name: 'Mistral: Mistral Nemo',
        free: false,
        vision: false,
        tools: false,
        contextLength: 131_072,
      },
    ]);
  });

  it('treats an id ending :free as free even without $0 pricing on the entry', () => {
    const mapped = mapOpenRouterModel({ id: 'some-vendor/some-model:free', pricing: {} });
    expect(mapped?.free).toBe(true);
  });

  it('rejects a malformed entry rather than throwing', () => {
    expect(mapOpenRouterModel({ name: 'no id' })).toBeNull();
    expect(mapOpenRouterModel(null)).toBeNull();
  });

  it('resolves listModels end-to-end against the sample catalog', async () => {
    const { client, ports } = makeClient();
    const promise = client.listModels();
    const sent = lastSent(ports[0]!);
    ports[0]!.emit({ type: 'models.list.result', id: sent.id, status: 200, body: { data: SAMPLE } });
    const models = await promise;
    expect(models.map((m) => m.id)).toEqual(SAMPLE.map((m) => m.id));
    expect(models[0]?.free).toBe(true);
    expect(models[3]?.tools).toBe(false);
  });

  it('rejects when the upstream status is not 200', async () => {
    const { client, ports } = makeClient();
    const promise = client.listModels();
    const sent = lastSent(ports[0]!);
    ports[0]!.emit({ type: 'models.list.result', id: sent.id, status: 500, body: {} });
    await expect(promise).rejects.toThrow(/500/);
  });
});

describe('reconnect with backoff', () => {
  it('reconnects after a disconnect, doubling the wait each time, capped', () => {
    const { client, ports } = makeClient();
    client.connect();
    expect(ports).toHaveLength(1);

    ports[0]!.disconnect();
    expect(ports).toHaveLength(1); // still waiting on the backoff timer

    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(2);

    ports[1]!.disconnect();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS); // the doubled delay has not elapsed yet
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(3);
  });

  it('resets the backoff to the initial delay once hello proves the new port is live', () => {
    const { client, ports } = makeClient();
    client.connect();
    ports[0]!.emit({ type: 'hello', hostVersion: '0.0.1', dev: false, cassette: 'off' });

    ports[0]!.disconnect();
    vi.advanceTimersByTime(INITIAL_BACKOFF_MS);
    expect(ports).toHaveLength(2);
  });

  it('caps the backoff at MAX_BACKOFF_MS', () => {
    const { client, ports } = makeClient();
    client.connect();
    let delay = INITIAL_BACKOFF_MS;
    for (let i = 0; i < 10; i++) {
      ports[ports.length - 1]!.disconnect();
      vi.advanceTimersByTime(delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
    expect(delay).toBe(MAX_BACKOFF_MS);
    expect(ports.length).toBe(11);
  });

  it('an explicit call reconnects immediately, bypassing a pending backoff wait', async () => {
    const { client, ports } = makeClient();
    client.connect();
    ports[0]!.disconnect();
    // No time advanced: still inside the backoff wait.
    const promise = client.keyStatus();
    expect(ports).toHaveLength(2);
    const sent = lastSent(ports[1]!);
    ports[1]!.emit({ type: 'key.status.result', id: sent.id, ready: true });
    await expect(promise).resolves.toEqual({ hostConnected: true, keyReady: true });
  });
});

describe('llm streaming subscription', () => {
  it('dispatches chunk/end by request id and unsubscribes on end', () => {
    const { client, ports } = makeClient();
    const chunks: string[] = [];
    let ended: { status: number; headers: Record<string, string> } | undefined;
    const id = client.sendLlmRequest({ url: 'https://openrouter.ai/api/v1/chat/completions', body: {} }, {
      onChunk: (bytes) => chunks.push(bytes),
      onEnd: (status, headers) => (ended = { status, headers }),
      onError: () => {
        throw new Error('unexpected error');
      },
    });
    const port = ports[0]!;
    port.emit({ type: 'llm.chunk', id, bytes: 'aGVsbG8=' });
    port.emit({ type: 'llm.chunk', id, bytes: 'd29ybGQ=' });
    port.emit({ type: 'llm.end', id, status: 200, headers: { 'content-type': 'text/event-stream' } });
    expect(chunks).toEqual(['aGVsbG8=', 'd29ybGQ=']);
    expect(ended).toEqual({ status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  it('errors all in-flight streams when the port disconnects', () => {
    const { client, ports } = makeClient();
    const errors: Array<[string, string]> = [];
    client.sendLlmRequest(
      { url: 'https://openrouter.ai/api/v1/chat/completions', body: {} },
      { onChunk: () => {}, onEnd: () => {}, onError: (code, message) => errors.push([code, message]) },
    );
    ports[0]!.disconnect();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('io');
  });

  it('abortLlm sends llm.abort for the given id', () => {
    const { client, ports } = makeClient();
    const id = client.sendLlmRequest(
      { url: 'https://openrouter.ai/api/v1/chat/completions', body: {} },
      { onChunk: () => {}, onEnd: () => {}, onError: () => {} },
    );
    client.abortLlm(id);
    const sent = ports[0]!.sent.find((m) => m.type === 'llm.abort');
    expect(sent).toEqual({ type: 'llm.abort', id });
  });
});

describe('onRunStart', () => {
  it('invokes registered handlers on a host-pushed run.start', () => {
    const { client, ports } = makeClient();
    const seen: string[] = [];
    const unsubscribe = client.onRunStart((msg) => seen.push(msg.runId));
    ports[0]!.emit({ type: 'run.start', runId: 'run-1', prompt: 'go' });
    expect(seen).toEqual(['run-1']);
    unsubscribe();
    ports[0]!.emit({ type: 'run.start', runId: 'run-2', prompt: 'go again' });
    expect(seen).toEqual(['run-1']);
  });
});

describe('appendRunLog', () => {
  it('redacts and sends without waiting for an ack (fire-and-forget)', () => {
    const { client, ports } = makeClient();
    client.appendRunLog('run-1', { kind: 'model.text', role: 'leader', text: 'Bearer sk-or-abc123', at: 1 });
    const sent = ports[0]!.sent.find((m) => m.type === 'runlog.append');
    expect(sent?.type).toBe('runlog.append');
    if (sent?.type !== 'runlog.append') throw new Error('expected runlog.append');
    expect(sent.runId).toBe('run-1');
    expect(JSON.stringify(sent.event)).not.toContain('sk-or-abc123');
    expect(sent.id).toBeUndefined();
  });
});
