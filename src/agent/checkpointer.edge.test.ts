/**
 * The vendor conformance suite (`@langchain/langgraph-checkpoint-validation`)
 * exercises `IndexedDBSaver` thoroughly against well-formed data, but has no
 * case for a corrupted/missing blob row -- e.g. a channel's blob was deleted
 * (or never written, for a reason other than the intentional `EMPTY_BLOB`
 * marker) while its `channel_versions` entry still names it. `#hydrate`
 * silently `continue`s over a missing blob (checkpointer.ts), which could
 * silently drop state rather than fail loudly. This file turns that implicit
 * behaviour into an asserted contract by writing a checkpoint through the
 * real `put()`, deleting one of its blob rows directly via `idb`, and reading
 * it back through the real `getTuple()`.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOB_STORE, IndexedDBSaver } from './checkpointer';

let dbSeq = 0;
const savers: IndexedDBSaver[] = [];

afterEach(async () => {
  for (const s of savers.splice(0)) await s.destroy();
});

function makeSaver(): IndexedDBSaver {
  const saver = new IndexedDBSaver({ dbName: `checkpointer-edge-${dbSeq++}` });
  savers.push(saver);
  return saver;
}

async function deleteBlob(dbName: string, key: [string, string, string, number | string]): Promise<void> {
  const db = await openDB(dbName, 1);
  await db.delete(BLOB_STORE, key);
  db.close();
}

describe('IndexedDBSaver: a missing blob for a versioned channel', () => {
  it('hydrates with that channel simply absent, rather than throwing or leaving it undefined-but-present', async () => {
    const saver = makeSaver();
    const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };
    const checkpoint = {
      v: 4,
      id: 'c1',
      ts: new Date().toISOString(),
      channel_values: { present: 'kept', missing: 'will-be-deleted' },
      channel_versions: { present: 1, missing: 1 },
      versions_seen: {},
    } as never;

    const nextConfig = await saver.put(config, checkpoint, { source: 'update', step: 0, parents: {} } as never, {
      present: 1,
      missing: 1,
    });

    // Delete the "missing" channel's blob directly, simulating corruption or
    // a write that never completed.
    await deleteBlob(saver.dbName, ['t1', '', 'missing', 1]);

    const tuple = await saver.getTuple(nextConfig);

    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.channel_values).toEqual({ present: 'kept' });
    expect('missing' in (tuple?.checkpoint.channel_values ?? {})).toBe(false);
    // The channel_versions entry itself is untouched -- only the value is gone.
    expect(tuple?.checkpoint.channel_versions).toEqual({ present: 1, missing: 1 });
  });

  it('does not throw when every versioned channel\'s blob is missing', async () => {
    const saver = makeSaver();
    const config = { configurable: { thread_id: 't2', checkpoint_ns: '' } };
    const checkpoint = {
      v: 4,
      id: 'c1',
      ts: new Date().toISOString(),
      channel_values: { a: 'x' },
      channel_versions: { a: 1 },
      versions_seen: {},
    } as never;

    const nextConfig = await saver.put(config, checkpoint, { source: 'update', step: 0, parents: {} } as never, {
      a: 1,
    });
    await deleteBlob(saver.dbName, ['t2', '', 'a', 1]);

    const tuple = await saver.getTuple(nextConfig);

    expect(tuple?.checkpoint.channel_values).toEqual({});
  });
});
