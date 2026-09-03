/**
 * A typed seam over `chrome.runtime.Port`.
 *
 * Deliberately hand-rolled: `@webext-core/messaging` is request/response only and has
 * no stream helper, and the side panel needs a long-lived event stream from the service
 * worker that survives SW restarts. Keeping this small keeps it testable — everything
 * above it talks to `BrowserPort`, never to `chrome.*`.
 */

/** The single wire format for everything that crosses a port. */
export interface Envelope<T = unknown> {
  type: string;
  id: string;
  payload: T;
}

/** The seam. `ChromePort` in production, `FakeBrowserPort` in tests. */
export interface BrowserPort {
  postMessage(message: Envelope): void;
  onMessage(handler: (message: Envelope) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  disconnect(): void;
}

/** `BrowserPort` backed by a real `chrome.runtime.Port`. */
export class ChromePort implements BrowserPort {
  constructor(private readonly port: chrome.runtime.Port) {}

  static connect(name: string): ChromePort {
    return new ChromePort(chrome.runtime.connect({ name }));
  }

  postMessage(message: Envelope): void {
    this.port.postMessage(message);
  }

  onMessage(handler: (message: Envelope) => void): () => void {
    const listener = (message: unknown) => handler(message as Envelope);
    this.port.onMessage.addListener(listener);
    return () => this.port.onMessage.removeListener(listener);
  }

  onDisconnect(handler: () => void): () => void {
    const listener = () => handler();
    this.port.onDisconnect.addListener(listener);
    return () => this.port.onDisconnect.removeListener(listener);
  }

  disconnect(): void {
    this.port.disconnect();
  }
}

/** In-memory `BrowserPort`. Use {@link createFakePortPair} to get a connected pair. */
export class FakeBrowserPort implements BrowserPort {
  peer?: FakeBrowserPort;
  private messageHandlers = new Set<(message: Envelope) => void>();
  private disconnectHandlers = new Set<() => void>();
  private connected = true;

  postMessage(message: Envelope): void {
    if (!this.connected) return;
    this.peer?.receive(message);
  }

  onMessage(handler: (message: Envelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const handler of [...this.disconnectHandlers]) handler();
    this.peer?.disconnect();
  }

  private receive(message: Envelope): void {
    if (!this.connected) return;
    for (const handler of [...this.messageHandlers]) handler(message);
  }
}

/** Two `FakeBrowserPort`s wired to each other, standing in for both ends of a port. */
export function createFakePortPair(): [FakeBrowserPort, FakeBrowserPort] {
  const a = new FakeBrowserPort();
  const b = new FakeBrowserPort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Typed view of one end of a port: `TIn` arrives, `TOut` is sent. */
export interface Channel<TIn, TOut> {
  readonly closed: boolean;
  /** Sends an envelope and returns its generated id. */
  send(type: string, payload: TOut): string;
  onMessage(handler: (message: Envelope<TIn>) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

let envelopeCounter = 0;

function nextId(): string {
  envelopeCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${envelopeCounter.toString(36)}-${random}`;
}

export function createChannel<TIn, TOut>(port: BrowserPort): Channel<TIn, TOut> {
  const handlers = new Set<(message: Envelope<TIn>) => void>();
  const closeHandlers = new Set<() => void>();
  let closed = false;

  const markClosed = () => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler();
    handlers.clear();
    closeHandlers.clear();
  };

  port.onMessage((message) => {
    if (closed) return;
    for (const handler of [...handlers]) handler(message as Envelope<TIn>);
  });
  port.onDisconnect(markClosed);

  return {
    get closed() {
      return closed;
    },
    send(type, payload) {
      const id = nextId();
      if (closed) return id;
      port.postMessage({ type, id, payload });
      return id;
    },
    onMessage(handler) {
      if (closed) return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose(handler) {
      if (closed) {
        handler();
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (closed) return;
      port.disconnect();
      markClosed();
    },
  };
}
