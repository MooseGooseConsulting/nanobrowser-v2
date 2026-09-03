import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameError, FrameParser, MAX_OUTBOUND_BYTES } from '../src/framing.ts';

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([head, body]);
}

describe('framing', () => {
  it('round-trips a message', () => {
    const p = new FrameParser();
    expect(p.push(encodeFrame({ type: 'hello', n: 1 }))).toEqual([{ type: 'hello', n: 1 }]);
  });

  it('writes a 4-byte little-endian length prefix', () => {
    const buf = encodeFrame({ a: 1 });
    expect(buf.readUInt32LE(0)).toBe(buf.byteLength - 4);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([7, 0, 0, 0])); // {"a":1} is 7 bytes
  });

  it('handles several frames in one chunk', () => {
    const p = new FrameParser();
    const chunk = Buffer.concat([frame({ i: 1 }), frame({ i: 2 }), frame({ i: 3 })]);
    expect(p.push(chunk)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(p.pending).toBe(0);
  });

  it('handles a frame split across chunks, including a split header', () => {
    const p = new FrameParser();
    const f = frame({ hello: 'world' });
    expect(p.push(f.subarray(0, 2))).toEqual([]);
    expect(p.push(f.subarray(2, 5))).toEqual([]);
    expect(p.push(f.subarray(5, f.byteLength - 1))).toEqual([]);
    expect(p.push(f.subarray(f.byteLength - 1))).toEqual([{ hello: 'world' }]);
  });

  it('emits whole frames and keeps the trailing partial', () => {
    const p = new FrameParser();
    const a = frame({ i: 1 });
    const b = frame({ i: 2 });
    expect(p.push(Buffer.concat([a, b.subarray(0, 6)]))).toEqual([{ i: 1 }]);
    expect(p.pending).toBe(6);
    expect(p.push(b.subarray(6))).toEqual([{ i: 2 }]);
  });

  it('decodes multi-byte UTF-8 split mid-character', () => {
    const p = new FrameParser();
    const f = frame({ s: 'héllo — ✅' });
    const cut = 6;
    expect(p.push(f.subarray(0, cut))).toEqual([]);
    expect(p.push(f.subarray(cut))).toEqual([{ s: 'héllo — ✅' }]);
  });

  it('rejects a frame larger than the inbound limit', () => {
    const p = new FrameParser(16);
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(1024, 0);
    expect(() => p.push(head)).toThrow(FrameError);
  });

  it('rejects an outbound message over the 1 MB host->extension limit', () => {
    expect(() => encodeFrame({ big: 'x'.repeat(MAX_OUTBOUND_BYTES) })).toThrow(FrameError);
  });

  it('rejects a body that is not JSON', () => {
    const p = new FrameParser();
    const body = Buffer.from('{not json', 'utf8');
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(body.byteLength, 0);
    expect(() => p.push(Buffer.concat([head, body]))).toThrow(FrameError);
  });
});
