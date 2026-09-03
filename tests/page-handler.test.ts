// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, installPageListener, resetPageListenerForTests } from '@/src/page/handler';
import type { PageRequest, PageResponse } from '@/src/page/handler';
import { resolveRef } from '@/src/page/snapshot';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: PageResponse) => void,
) => boolean | undefined;

function fakeChrome(): { api: { runtime: { onMessage: { addListener(fn: Listener): void } } }; listeners: Listener[] } {
  const listeners: Listener[] = [];
  return {
    listeners,
    api: {
      runtime: {
        onMessage: {
          addListener(fn: Listener) {
            listeners.push(fn);
          },
        },
      },
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetPageListenerForTests();
  // jsdom has no real scrollBy; stub it so the scroll op exercises the code path.
  (window as unknown as { scrollBy: unknown }).scrollBy = () => undefined;
});

describe('handle', () => {
  it('answers ping with page metrics from the injected side', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
    document.title = 'Threads';
    expect(handle({ op: 'ping' })).toMatchObject({
      ok: true,
      pong: true,
      title: 'Threads',
      devicePixelRatio: 2,
      width: 1280,
      height: 720,
    });
  });

  it('routes every documented op', () => {
    document.body.innerHTML =
      '<button>Go</button><input type="text"><select aria-label="m"><option value="a">A</option></select>';
    const snap = handle({ op: 'snapshot' }) as PageResponse & { text: string };
    expect(snap.ok).toBe(true);
    expect(snap.text).toContain('[ref=e1]');

    const buttonRef = 'e1';
    expect(resolveRef(buttonRef)?.localName).toBe('button');
    expect(handle({ op: 'click', ref: 'e1' })).toEqual({ ok: true });
    expect(handle({ op: 'hover', ref: 'e1' })).toEqual({ ok: true });
    expect(handle({ op: 'type', ref: 'e2', text: 'hi' })).toEqual({ ok: true });
    expect(handle({ op: 'press', key: 'Enter' })).toEqual({ ok: true });
    expect(handle({ op: 'select', ref: 'e3', value: 'a' })).toEqual({ ok: true });
    expect(handle({ op: 'scroll', direction: 'down' })).toMatchObject({ ok: true });
    expect(handle({ op: 'getBox', ref: 'e1' })).toMatchObject({ ok: true });
  });

  it('passes snapshot options through', () => {
    document.body.innerHTML = '<button>A</button><button>B</button><button>C</button>';
    const res = handle({ op: 'snapshot', maxNodes: 2 } satisfies PageRequest) as PageResponse & {
      nodes: number;
      truncated: boolean;
    };
    expect(res.nodes).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('rejects malformed and unknown requests without throwing', () => {
    expect(handle(null)).toEqual({ ok: false, error: 'malformed page request' });
    expect(handle({ nope: 1 })).toEqual({ ok: false, error: 'malformed page request' });
    expect(handle({ op: 'launchMissiles' })).toEqual({ ok: false, error: 'unknown op: launchMissiles' });
  });

  it('turns a thrown error into { ok:false, error }', () => {
    document.body.innerHTML = '<button>Go</button>';
    handle({ op: 'snapshot' });
    const el = resolveRef('e1') as HTMLElement;
    el.getBoundingClientRect = () => {
      throw new Error('layout exploded');
    };
    expect(handle({ op: 'getBox', ref: 'e1' })).toEqual({ ok: false, error: 'layout exploded' });
  });
});

describe('installPageListener', () => {
  it('registers exactly one listener and is idempotent across re-injection', () => {
    const { api, listeners } = fakeChrome();
    expect(installPageListener(api)).toBe(true);
    expect(installPageListener(api)).toBe(false);
    expect(installPageListener(api)).toBe(false);
    expect(listeners).toHaveLength(1);
  });

  it('replies synchronously and returns false so the channel is not held open', () => {
    const { api, listeners } = fakeChrome();
    installPageListener(api);
    document.body.innerHTML = '<button>Go</button>';
    let reply: PageResponse | undefined;
    const kept = listeners[0]?.({ op: 'ping' }, {}, (r) => {
      reply = r;
    });
    expect(kept).toBe(false);
    expect(reply).toMatchObject({ ok: true, pong: true });
  });

  it('ignores messages that are not page requests, so other listeners still see them', () => {
    const { api, listeners } = fakeChrome();
    installPageListener(api);
    let called = false;
    const kept = listeners[0]?.({ type: 'run.start' }, {}, () => {
      called = true;
    });
    expect(kept).toBe(false);
    expect(called).toBe(false);
  });

  it('adds no global to the page and no node to the DOM', () => {
    const { api } = fakeChrome();
    const before = document.body.innerHTML;
    const keysBefore = Object.keys(window).length;
    installPageListener(api);
    expect(document.body.innerHTML).toBe(before);
    // The dedupe marker lives on the ISOLATED world's globalThis, which in this test IS
    // `window`; in the extension those are different objects and the page never sees it.
    expect(Object.keys(window).length - keysBefore).toBeLessThanOrEqual(1);
  });

  it('does nothing when chrome.runtime is absent instead of throwing', () => {
    expect(installPageListener({ runtime: {} } as never)).toBe(false);
  });
});
