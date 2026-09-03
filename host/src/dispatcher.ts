import { getInjector, type InputInjector } from './input/index.ts';
import type { LlmProxy } from './llm.ts';
import { log } from './log.ts';
import type { ErrorCode, InboundMsg, InputMsg, LlmRequestMsg, OutboundMsg, RunLogAppendMsg } from './protocol.ts';
import { appendRunLog, assertRunId, RunLogError } from './runlog.ts';

export interface DispatcherDeps {
  send: (msg: OutboundMsg) => void;
  llm: LlmProxy;
  runsDir: string;
  /** Mirrors run-log events to dev unix-socket subscribers. */
  onRunEvent?: (runId: string, event: unknown) => void;
  injector?: () => InputInjector;
}

const INPUT_TYPES = new Set(['input.moveTo', 'input.click', 'input.typeText', 'input.key']);

export class Dispatcher {
  readonly #deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  #fail(id: string | undefined, code: ErrorCode, message: string): void {
    this.#deps.send({ type: 'error', id, code, message });
  }

  async handle(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') {
      return this.#fail(undefined, 'bad_request', 'message must be an object with a string "type"');
    }
    const msg = raw as InboundMsg;
    const id = (raw as { id?: unknown }).id;
    if (msg.type !== 'runlog.append' && typeof id !== 'string') {
      return this.#fail(undefined, 'bad_request', `${msg.type} requires a string "id"`);
    }

    switch (msg.type) {
      case 'key.status': {
        const { ready, reason } = await this.#deps.llm.keyStatus();
        return this.#deps.send({ type: 'key.status.result', id: msg.id, ready, ...(reason ? { reason } : {}) });
      }

      case 'models.list': {
        try {
          const { status, body } = await this.#deps.llm.models();
          return this.#deps.send({ type: 'models.list.result', id: msg.id, status, body });
        } catch (err) {
          return this.#fail(msg.id, 'upstream', (err as Error).message);
        }
      }

      case 'llm.request': {
        const m = msg as LlmRequestMsg;
        if (typeof m.url !== 'string' || m.url.length === 0) {
          return this.#fail(m.id, 'bad_request', 'llm.request requires a string "url"');
        }
        return this.#deps.llm.request(m);
      }

      case 'llm.abort':
        this.#deps.llm.abort(msg.id);
        return;

      case 'runlog.append': {
        const m = msg as RunLogAppendMsg;
        try {
          assertRunId(m.runId);
        } catch (err) {
          return this.#fail(m.id, 'bad_request', (err as RunLogError).message);
        }
        try {
          await appendRunLog(m.runId, m.event, this.#deps.runsDir);
        } catch (err) {
          return this.#fail(m.id, 'io', (err as Error).message);
        }
        this.#deps.onRunEvent?.(m.runId, m.event);
        return this.#deps.send({ type: 'runlog.ack', ...(m.id ? { id: m.id } : {}), runId: m.runId, ok: true });
      }

      default: {
        if (INPUT_TYPES.has(msg.type)) return this.#handleInput(msg as InputMsg);
        log('warn', 'unknown message type', { type: (msg as { type: string }).type });
        return this.#fail(typeof id === 'string' ? id : undefined, 'unknown_type', `unknown type ${msg.type}`);
      }
    }
  }

  async #handleInput(m: InputMsg): Promise<void> {
    const injector = (this.#deps.injector ?? getInjector)();
    try {
      switch (m.type) {
        case 'input.moveTo':
          await injector.moveTo(Number(m.x), Number(m.y));
          break;
        case 'input.click':
          await injector.click((m.button ?? 'left') as 'left');
          break;
        case 'input.typeText':
          await injector.typeText(String(m.text ?? ''));
          break;
        case 'input.key':
          await injector.key(String(m.name ?? ''), (m.action ?? 'press') as 'press');
          break;
      }
      this.#deps.send({ type: 'input.result', id: m.id, ok: true, injector: injector.name });
    } catch (err) {
      this.#deps.send({
        type: 'input.result',
        id: m.id,
        ok: false,
        injector: injector.name,
        reason: (err as Error).message,
      });
    }
  }
}
