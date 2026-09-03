/**
 * (h) The IndexedDB saver must pass the official conformance suite. Ours is the
 * only thing standing between a killed MV3 worker and a lost run, so "it worked
 * on the happy path" is not evidence.
 *
 * `@langchain/langgraph-checkpoint-validation` calls `describe`/`it`/`expect`
 * as globals. Rather than switch the whole repo to `globals: true`, they are
 * installed on `globalThis` for this file only, then the suite is imported.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBSaver } from './checkpointer';

Object.assign(globalThis, {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
});

const { validate } = await import('@langchain/langgraph-checkpoint-validation');

let dbSeq = 0;

validate({
  checkpointerName: 'IndexedDBSaver',
  createCheckpointer: () => new IndexedDBSaver({ dbName: `validation-${dbSeq++}` }),
  destroyCheckpointer: (saver) => saver.destroy(),
});
