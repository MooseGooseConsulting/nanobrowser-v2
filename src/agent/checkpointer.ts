/**
 * IndexedDB checkpointer.
 *
 * There is no IndexedDB `BaseCheckpointSaver` on npm (docs/research/langgraph.md
 * §3), so this is ours. It is load-bearing: an MV3 service worker is killed after
 * ~30s idle, and the only thing that survives is what is in this store. It is
 * conformance-tested against `@langchain/langgraph-checkpoint-validation`.
 *
 * Serialization goes through the inherited `this.serde`, which round-trips
 * `BaseMessage` subclasses; hand-rolled `JSON.stringify` would not.
 *
 * Layout: three object stores with compound keys, so every read is a range scan
 * rather than a full-store filter, and a checkpoint plus everything hanging off
 * it can be deleted in one transaction.
 *
 * Channel values are stored as per-channel, per-version blobs and only for the
 * channels named in `newVersions`; `getTuple` reassembles them from
 * `channel_versions`. That is what the validation suite's channel-delta case
 * requires, and it matters here for its own sake: with `durability: "sync"` a
 * checkpoint is written every superstep, and the alternative is re-serializing
 * the whole message history into IndexedDB on every follower step.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

export const CHECKPOINT_STORE = 'checkpoints';
export const WRITES_STORE = 'writes';
export const BLOB_STORE = 'blobs';

/** Marks a channel that was versioned but carried no value. */
const EMPTY_BLOB = '__empty__';
export const DEFAULT_DB_NAME = 'nanobrowser-agent-checkpoints';

interface CheckpointRecord {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  checkpoint_type: string;
  checkpoint: Uint8Array;
  metadata_type: string;
  metadata: Uint8Array;
}

interface WriteRecord {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  widx: number;
  channel: string;
  value_type: string;
  value: Uint8Array;
}

interface BlobRecord {
  thread_id: string;
  checkpoint_ns: string;
  channel: string;
  version: number | string;
  value_type: string;
  value: Uint8Array;
}

interface CheckpointDB extends DBSchema {
  [CHECKPOINT_STORE]: {
    key: [string, string, string];
    value: CheckpointRecord;
  };
  [WRITES_STORE]: {
    key: [string, string, string, string, number];
    value: WriteRecord;
  };
  [BLOB_STORE]: {
    key: [string, string, string, number | string];
    value: BlobRecord;
  };
}

/**
 * An empty array is greater than any string under IndexedDB key ordering
 * (number < date < string < binary < array), which makes it the open upper
 * bound for a compound-key prefix scan.
 */
const UPPER = [] as unknown as string;

function prefixRange(prefix: string[]): IDBKeyRange {
  return IDBKeyRange.bound([...prefix], [...prefix, UPPER]);
}

export interface IndexedDBSaverOptions {
  dbName?: string;
  serde?: SerializerProtocol;
  /** Injectable for tests; defaults to the ambient `indexedDB`. */
  indexedDB?: IDBFactory;
}

export class IndexedDBSaver extends BaseCheckpointSaver {
  readonly dbName: string;

  #db?: Promise<IDBPDatabase<CheckpointDB>>;
  #factory?: IDBFactory;

  constructor(options: IndexedDBSaverOptions = {}) {
    super(options.serde);
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.#factory = options.indexedDB;
  }

  #open(): Promise<IDBPDatabase<CheckpointDB>> {
    this.#db ??= openDB<CheckpointDB>(this.dbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
          db.createObjectStore(CHECKPOINT_STORE, {
            keyPath: ['thread_id', 'checkpoint_ns', 'checkpoint_id'],
          });
        }
        if (!db.objectStoreNames.contains(WRITES_STORE)) {
          db.createObjectStore(WRITES_STORE, {
            keyPath: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'widx'],
          });
        }
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE, {
            keyPath: ['thread_id', 'checkpoint_ns', 'channel', 'version'],
          });
        }
      },
      ...(this.#factory ? { indexedDB: this.#factory } : {}),
    } as Parameters<typeof openDB<CheckpointDB>>[2]);
    return this.#db;
  }

  /** Releases the underlying connection. Tests call this between cases. */
  async close(): Promise<void> {
    if (!this.#db) return;
    const db = await this.#db;
    db.close();
    this.#db = undefined;
  }

  /** Closes and deletes the whole database. */
  async destroy(): Promise<void> {
    await this.close();
    const factory = this.#factory ?? globalThis.indexedDB;
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onblocked = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async #pendingWrites(
    thread_id: string,
    checkpoint_ns: string,
    checkpoint_id: string,
  ): Promise<CheckpointPendingWrite[]> {
    const db = await this.#open();
    const rows = await db.getAll(
      WRITES_STORE,
      prefixRange([thread_id, checkpoint_ns, checkpoint_id]),
    );
    const out: CheckpointPendingWrite[] = [];
    for (const row of rows) {
      out.push([row.task_id, row.channel, await this.serde.loadsTyped(row.value_type, row.value)]);
    }
    return out;
  }

  /**
   * Pre-v4 checkpoints stored pending `Send`s as writes on the parent. Mirrors
   * `MemorySaver._migratePendingSends` so old threads still resume.
   */
  async #migratePendingSends(
    checkpoint: Checkpoint,
    thread_id: string,
    checkpoint_ns: string,
    parent_checkpoint_id: string,
  ): Promise<void> {
    const parentWrites = await this.#pendingWrites(thread_id, checkpoint_ns, parent_checkpoint_id);
    const sends = parentWrites.filter(([, channel]) => channel === TASKS).map(([, , value]) => value);
    const mutable = checkpoint as Checkpoint;
    mutable.channel_values ??= {};
    mutable.channel_values[TASKS] = sends;
    mutable.channel_versions ??= {};
    mutable.channel_versions[TASKS] =
      Object.keys(mutable.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(mutable.channel_versions))
        : this.getNextVersion(undefined);
  }

  /** Rebuilds `channel_values` from the per-channel blobs `put` wrote. */
  async #hydrate(row: CheckpointRecord, checkpoint: Checkpoint): Promise<void> {
    const db = await this.#open();
    const values: Record<string, unknown> = { ...(checkpoint.channel_values ?? {}) };
    for (const [channel, version] of Object.entries(checkpoint.channel_versions ?? {})) {
      const blob = await db.get(BLOB_STORE, [row.thread_id, row.checkpoint_ns, channel, version]);
      if (blob === undefined || blob.value_type === EMPTY_BLOB) continue;
      values[channel] = await this.serde.loadsTyped(blob.value_type, blob.value);
    }
    checkpoint.channel_values = values;
  }

  async #toTuple(row: CheckpointRecord, config?: RunnableConfig): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpoint_type,
      row.checkpoint,
    )) as Checkpoint;
    await this.#hydrate(row, checkpoint);
    if (checkpoint.v < 4 && row.parent_checkpoint_id !== undefined) {
      await this.#migratePendingSends(
        checkpoint,
        row.thread_id,
        row.checkpoint_ns,
        row.parent_checkpoint_id,
      );
    }
    const tuple: CheckpointTuple = {
      config: config ?? {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata: (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata,
      )) as CheckpointMetadata,
      pendingWrites: await this.#pendingWrites(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
      ),
    };
    if (row.parent_checkpoint_id !== undefined) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id as string | undefined;
    if (thread_id === undefined) return undefined;
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpoint_id = getCheckpointId(config);
    const db = await this.#open();

    if (checkpoint_id) {
      const row = await db.get(CHECKPOINT_STORE, [thread_id, checkpoint_ns, checkpoint_id]);
      return row ? this.#toTuple(row, config) : undefined;
    }

    // No id: the latest checkpoint. uuid6 ids sort lexicographically by time,
    // so the greatest key in the prefix range is the newest.
    const cursor = await db
      .transaction(CHECKPOINT_STORE)
      .store.openCursor(prefixRange([thread_id, checkpoint_ns]), 'prev');
    return cursor ? this.#toTuple(cursor.value) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let { limit } = options ?? {};
    const thread_id = config.configurable?.thread_id as string | undefined;
    const checkpoint_ns = config.configurable?.checkpoint_ns as string | undefined;
    const checkpoint_id = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;

    const db = await this.#open();
    const range =
      thread_id !== undefined
        ? checkpoint_ns !== undefined
          ? prefixRange([thread_id, checkpoint_ns])
          : prefixRange([thread_id])
        : undefined;
    const rows = await db.getAll(CHECKPOINT_STORE, range);

    // Same ordering MemorySaver yields: grouped by thread then namespace,
    // newest checkpoint first inside each group.
    rows.sort((a, b) => {
      if (a.thread_id !== b.thread_id) return a.thread_id < b.thread_id ? -1 : 1;
      if (a.checkpoint_ns !== b.checkpoint_ns) return a.checkpoint_ns < b.checkpoint_ns ? -1 : 1;
      return a.checkpoint_id < b.checkpoint_id ? 1 : a.checkpoint_id > b.checkpoint_id ? -1 : 0;
    });

    for (const row of rows) {
      // The range only narrows when a thread is given; the namespace filter must
      // hold either way.
      if (checkpoint_ns !== undefined && row.checkpoint_ns !== checkpoint_ns) continue;
      if (checkpoint_id && row.checkpoint_id !== checkpoint_id) continue;
      if (beforeId && row.checkpoint_id >= beforeId) continue;
      const metadata = (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata,
      )) as CheckpointMetadata;
      if (filter && !Object.entries(filter).every(([k, v]) => (metadata as never)[k] === v)) {
        continue;
      }
      if (limit !== undefined) {
        if (limit <= 0) break;
        limit -= 1;
      }
      yield this.#toTuple(row);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id as string | undefined;
    if (thread_id === undefined) {
      throw new Error(
        'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.',
      );
    }
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const prepared = copyCheckpoint(checkpoint);

    // Only the channels named in `newVersions` changed this step. Store those as
    // blobs and leave the checkpoint blob itself free of channel payloads.
    const channelValues = prepared.channel_values ?? {};
    prepared.channel_values = {};
    const blobs: BlobRecord[] = [];
    for (const [channel, version] of Object.entries(newVersions)) {
      const present =
        Object.prototype.hasOwnProperty.call(channelValues, channel) &&
        channelValues[channel] !== undefined;
      if (present) {
        const [value_type, bytes] = await this.serde.dumpsTyped(channelValues[channel]);
        blobs.push({ thread_id, checkpoint_ns, channel, version, value_type, value: bytes });
      } else {
        blobs.push({
          thread_id,
          checkpoint_ns,
          channel,
          version,
          value_type: EMPTY_BLOB,
          value: new Uint8Array(),
        });
      }
    }

    const [[checkpoint_type, checkpointBytes], [metadata_type, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);

    const record: CheckpointRecord = {
      thread_id,
      checkpoint_ns,
      checkpoint_id: checkpoint.id,
      checkpoint_type,
      checkpoint: checkpointBytes,
      metadata_type,
      metadata: metadataBytes,
    };
    const parent = config.configurable?.checkpoint_id as string | undefined;
    if (parent !== undefined) record.parent_checkpoint_id = parent;

    // One transaction: a worker killed between the blobs and the checkpoint would
    // leave a checkpoint that cannot be hydrated.
    const db = await this.#open();
    const tx = db.transaction([CHECKPOINT_STORE, BLOB_STORE], 'readwrite');
    const blobStore = tx.objectStore(BLOB_STORE);
    for (const blob of blobs) await blobStore.put(blob);
    await tx.objectStore(CHECKPOINT_STORE).put(record);
    await tx.done;

    return {
      configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread_id = config.configurable?.thread_id as string | undefined;
    const checkpoint_id = config.configurable?.checkpoint_id as string | undefined;
    if (thread_id === undefined) {
      throw new Error(
        'Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.',
      );
    }
    if (checkpoint_id === undefined) {
      throw new Error(
        'Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.',
      );
    }
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';

    const serialized = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [value_type, bytes] = await this.serde.dumpsTyped(value);
        const widx = WRITES_IDX_MAP[channel] ?? idx;
        return { channel, value_type, value: bytes, widx } as const;
      }),
    );

    // One transaction: the worker can die between writes, and LangGraph replays
    // pending writes on resume only if they are all there.
    const db = await this.#open();
    const tx = db.transaction(WRITES_STORE, 'readwrite');
    for (const w of serialized) {
      const key: [string, string, string, string, number] = [
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        taskId,
        w.widx,
      ];
      // Regular writes (idx >= 0) are written once; special writes (negative
      // index, e.g. errors) overwrite. Mirrors MemorySaver.
      if (w.widx >= 0 && (await tx.store.get(key)) !== undefined) continue;
      await tx.store.put({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: taskId,
        widx: w.widx,
        channel: w.channel,
        value_type: w.value_type,
        value: w.value,
      });
    }
    await tx.done;
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction([CHECKPOINT_STORE, WRITES_STORE, BLOB_STORE], 'readwrite');
    await Promise.all([
      tx.objectStore(CHECKPOINT_STORE).delete(prefixRange([threadId])),
      tx.objectStore(WRITES_STORE).delete(prefixRange([threadId])),
      tx.objectStore(BLOB_STORE).delete(prefixRange([threadId])),
      tx.done,
    ]);
  }
}
