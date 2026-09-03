/**
 * Chrome native-messaging framing: 4-byte little-endian unsigned length prefix
 * followed by that many bytes of UTF-8 JSON. Same format in both directions.
 *
 * Size limits (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
 *   extension -> host : 64 MiB per message
 *   host -> extension : 1 MB per message
 */

export const MAX_INBOUND_BYTES = 64 * 1024 * 1024; // 64 MiB, extension -> host
export const MAX_OUTBOUND_BYTES = 1024 * 1024; // 1 MB, host -> extension

export class FrameError extends Error {}

/** Encode one message as a native-messaging frame. */
export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.byteLength > MAX_OUTBOUND_BYTES) {
    throw new FrameError(
      `outbound message is ${json.byteLength} bytes, over the ${MAX_OUTBOUND_BYTES}-byte host->extension limit`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental parser. Feed it arbitrary chunks; it returns whichever whole
 * messages became available. Handles partial headers, partial bodies, and
 * several frames arriving inside a single chunk.
 */
export class FrameParser {
  #buf: Buffer = Buffer.alloc(0);
  readonly #maxBytes: number;

  constructor(maxBytes: number = MAX_INBOUND_BYTES) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.byteLength === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.#buf.byteLength < 4) break;
      const len = this.#buf.readUInt32LE(0);
      if (len > this.#maxBytes) {
        throw new FrameError(`inbound frame declares ${len} bytes, over the ${this.#maxBytes}-byte limit`);
      }
      if (this.#buf.byteLength < 4 + len) break;
      const body = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (err) {
        throw new FrameError(`frame body is not valid JSON: ${(err as Error).message}`);
      }
      out.push(parsed);
    }
    return out;
  }

  /** Bytes buffered but not yet forming a whole frame. */
  get pending(): number {
    return this.#buf.byteLength;
  }
}
