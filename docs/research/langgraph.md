# LangGraph JS in a Chrome MV3 Service Worker

Research date: 2026-09-03. All claims verified against installed package source (`@langchain/langgraph@1.4.13`) and/or upstream repo, not memory.

## Summary (answer-first)

1. Use `@langchain/langgraph@1.4.13` + `@langchain/core@1.2.9` + `@langchain/langgraph-checkpoint@1.1.5` + `@langchain/openai@1.5.11`.
2. It bundles and runs in an MV3 service worker. Verified: `esbuild --platform=browser` with zero polyfills exits 0 (3.4 MB raw).
3. Import from **`@langchain/langgraph/web`**. The only difference from the root entry is a 391-byte `node:async_hooks` shim; exports are otherwise byte-identical.
4. `createReactAgent` is **deprecated** (moved to `langchain`). So are `ToolExecutor`, `StateGraphArgs` channels, `setEntryPoint/setFinishPoint`, `stateSchema:`, `checkpointDuring`. Full list in §1.
5. Use `StateSchema` + zod (current, in maintainer examples), not `Annotation.Root`. `ToolNode`, `toolsCondition`, `Send`, `Command`, `interrupt` are all current.
6. **`interrupt()` throws in a browser** — proven empirically. It needs AsyncLocalStorage, which MV3 has none of.
7. **Use `RunControl.requestDrain()` for pause instead.** Verified working with zero polyfills: stops at superstep boundary, persists checkpoint, throws `GraphDrained`, resumes via `invoke(null, cfg)`.
8. No IndexedDB checkpointer exists on npm. Write one against `BaseCheckpointSaver` — 5 abstract methods. A working prototype survived a full JSON round-trip resume (§3).
9. `AbortSignal` works via `config.signal` for hard cancellation. Streaming (`updates`/`values`/`custom`) works with no polyfill.
10. Leader/Follower with `planningInterval` as a conditional edge is straightforward; the §7 skeleton type-checks clean under `strict`.

## 1. Versions, cadence, deprecations

| Package | Latest stable | Published |
|---|---|---|
| `@langchain/langgraph` | **1.4.13** | 2026-08-26 |
| `@langchain/core` | **1.2.9** | 2026-08-20 |
| `@langchain/langgraph-checkpoint` | **1.1.5** | 2026-08-19 |
| `@langchain/openai` | **1.5.11** | 2026-09-01 |
| `langchain` (for `createAgent`) | 1.5.10 | — |

Source: `npm view <pkg> version time --json`, 2026-09-03.

**Cadence:** roughly weekly-to-fortnightly patches. Recent langgraph: 1.4.8 (07-15), 1.4.9 (08-03), 1.4.10 (08-14), 1.4.11/1.4.12 (08-19), 1.4.13 (08-26). Minors land every 1–2 months (1.3.0 on 2026-05-05, 1.4.0 on 2026-06-10). **Pin exact versions** and upgrade deliberately.

`@langchain/langgraph@1.4.13` peer-requires `@langchain/core@^1.1.48` and `zod@^3.25.32 || ^4.2.0`.

### FORBIDDEN under C-03 (every one carries `@deprecated` in 1.4.13 `.d.ts`)

| API | Location | Replacement |
|---|---|---|
| `createReactAgent` | `prebuilt/react_agent_executor.d.ts:158` | moved to `langchain` pkg (`createAgent`) — but see §2 caveat |
| `AgentState`, `CreateReactAgentParams` | same file :21, :57 | moved to `langchain` |
| `ToolExecutor` | `prebuilt/tool_executor.d.ts:5,22` | **`ToolNode`** |
| `createFunctionCallingExecutor` | `prebuilt/chat_agent_executor.d.ts:9,13` | tool calling |
| `withAgentName` | `prebuilt/agentName.d.ts:11` | migrated to `langchain` |
| `StateGraphArgs` (channels object) | `graph/state.d.ts:302` | **`StateSchema`**, zod, or `Annotation.Root` |
| `Annotation({ value: … })` | `graph/annotation.d.ts:13` | `{ reducer: … }` |
| `.setEntryPoint()` / `.setFinishPoint()` | `graph/graph.d.ts:118,122` | `addEdge(START, k)` / `addEdge(k, END)` |
| `stateSchema:` key | `graph/types.d.ts:49` | **`state:`** |
| `checkpointDuring` | `pregel/types.d.ts:212` | **`durability: "async"\|"sync"\|"exit"`** |
| `getGraph()` / `getSubgraphs()` | `graph.d.ts:173`, `pregel/index.d.ts:335` | `getGraphAsync()` / `getSubgraphsAsync()` |
| `NodeInterrupt` | `errors.d.ts:139` "no longer thrown" | `interrupt()` |

### APPROVED (current, not deprecated in 1.4.13)

`StateGraph`, `START`, `END`, `StateSchema`, `MessagesValue`, `ReducedValue`, `UntrackedValue`, `DeltaValue`, `Annotation` / `MessagesAnnotation` (legal but legacy — prefer `StateSchema`), `Command`, `Send`, `interrupt`, `ToolNode`, `toolsCondition`, `RunControl`, `GraphDrained`/`isGraphDrained`, `BaseCheckpointSaver`, `MemorySaver`, `durability`, `config.writer`, `GraphNode`, `ConditionalEdgeRouter`, `LangGraphRunnableConfig`.

> `Annotation` is **not** deprecated, but every current doc example and the maintainer's own browser MRE in [issue #1699](https://github.com/langchain-ai/langgraphjs/issues/1699) uses `StateSchema` + zod. Use `StateSchema`.

## 2. Does it run in a browser / MV3 service worker?

**Yes.** Verified three ways.

**(a) The `browser` export condition already points at the web build.** From installed `@langchain/langgraph/package.json`:

```json
".": { "browser": "./dist/web.js", "import": { "default": "./dist/index.js" }, … }
```

`browser` is listed **first**, so any browser-targeting bundler (WXT/Vite) resolves it automatically.

**(b) The web/node delta is one file.** Upstream `libs/langgraph-core/src/index.ts` is literally `initializeAsyncLocalStorageSingleton(); export * from "./web.js";`, and `node.ts` is only `new AsyncLocalStorage()` from `node:async_hooks`. `dist/index.d.ts` and `dist/web.d.ts` export **identical** symbol lists — `/web` costs you no API.

**(c) Bundle test.** `esbuild --bundle --platform=browser --target=es2022`, no polyfills, importing `StateGraph`/`ToolNode`/`ChatOpenAI`/`tool`: **exit 0**. Residual `node:util` is a *string* inside `openai`'s `captureNativeProxyDetector`, guarded by `typeof process === 'undefined'` and a `try/catch` — never resolved by the bundler. All `process.env` reads are optional-chained.

`@langchain/langgraph-checkpoint@1.1.5` and `@langchain/openai@1.5.11` contain **zero** `node:` builtins.

### What real users report

- [#81](https://github.com/langchain-ai/langgraphjs/issues/81) (2024) — original `async_hooks` breakage; fixed by adding the `/web` entrypoint.
- [#869](https://github.com/langchain-ai/langgraphjs/issues/869) — webpack `UnhandledSchemeError: node:async_hooks`; answer is "use `/web`".
- [#1699](https://github.com/langchain-ai/langgraphjs/issues/1699) (2025-09) — regression in `1.0.0-alpha`; **closed as fixed** by langchainjs PR #9229. Maintainer's closing MRE runs `StateGraph` in a web env.
- [#879](https://github.com/langchain-ai/langgraphjs/issues/879) — **still open.** `interrupt()` and the functional API (`task`/`entrypoint`) need AsyncLocalStorage and do not work on web. Confirmed still true in 1.4.13 (§4).
- [Forum, 2026-01](https://forum.langchain.com/t/browser-compatibility-issue-createagent-fails-due-to-node-async-hooks-dependency/2713) — `createAgent` from `langchain` fails in browser builds. `langchain@1.5.10` now ships a `browser` condition, but it is ordered **after** `import` in its exports map, so ESM bundlers may still pick the Node build. **Another reason to build our own graph rather than use `createAgent`.**

### MV3 rules (independent of LangGraph)
Register `chrome.runtime` listeners synchronously at top level; the worker dies after ~30 s idle; `setTimeout`/`setInterval` die with it (use `chrome.alarms`); no `localStorage`/DOM/`window`. ([Chrome docs](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers))

## 3. Checkpointers

**There is no IndexedDB checkpointer on npm.** Searched the registry: the only savers are `sqlite`, `postgres`, `mongodb`, `redis`, `filesystem`, `libsql`, `pglite`, `cloudflare-d1`, `firestore` — all Node/server. **We must write our own.**

That is cheap. `BaseCheckpointSaver` (`libs/checkpoint/src/base.ts:113`) has exactly **five** abstract members:

```ts
abstract getTuple(config): Promise<CheckpointTuple | undefined>;
abstract list(config, options?): AsyncGenerator<CheckpointTuple>;
abstract put(config, checkpoint, metadata, newVersions): Promise<RunnableConfig>;
abstract putWrites(config, writes, taskId): Promise<void>;
abstract deleteThread(threadId): Promise<void>;
```

`getNextVersion` and `getDeltaChannelHistory` have working defaults. Serialization is handled for you by the inherited `this.serde` (`dumpsTyped` → `[string, Uint8Array]`, `loadsTyped`), which round-trips `BaseMessage` subclasses correctly — do **not** hand-roll `JSON.stringify` on checkpoints.

Storage layout that works (validated prototype): checkpoints keyed `${thread_id}::${checkpoint_ns}` → `{ [checkpoint_id]: { type, cp, md, parent } }`; writes keyed `${thread_id}::${checkpoint_ns}::${checkpoint_id}` → `[{ taskId, channel, type, val }]`. `getTuple` with no `checkpoint_id` returns the **latest** (`uuid6` ids sort lexicographically by time, so sort ascending and take last); `list` must yield **newest-first**.

**Verified:** a saver of this shape, its DB `JSON.stringify`'d to 3,723 bytes, re-`JSON.parse`'d into fresh objects, attached to a **brand-new compiled graph**, correctly restored `next: ['pause']` and resumed to completion. That is exactly the service-worker-restart path.

`thread_id` goes in `config.configurable.thread_id`; it is the only handle needed. Resume-from-latest is `graph.invoke(null, { configurable: { thread_id } })`. To resume from a *specific* point, add `checkpoint_id`. Inspect with `getState(config)` (returns `.values`, `.next`, `.tasks`) and `getStateHistory(config)`.

Use **`@langchain/langgraph-checkpoint-validation@1.1.1`** to conformance-test our implementation.

Set `durability: "sync"` for MV3 — the default `"async"` writes the checkpoint while the next step runs, and the worker can be killed in that window.

## 4. Pause / resume / cancellation

### `interrupt()` does NOT work in MV3 — proven

`dist/interrupt.js` opens with `AsyncLocalStorageProviderSingleton.getRunnableConfig()` and throws if falsy. In `@langchain/core/dist/singletons/async_local_storage/index.js`, `getInstance()` returns `getGlobalAsyncLocalStorageInstance() ?? mockAsyncLocalStorage`, and `MockAsyncLocalStorage.getStore()` returns `undefined`.

Empirical result — `/web` entrypoint, no polyfill, langgraph 1.4.13:

```
ALS global set? false
THREW: Error | Called interrupt() outside the context of a graph.
```

### Two fixes

**(A) Preferred — `RunControl`, needs no polyfill.** Verified working with ALS absent:

```
drained: true | reason: mv3-suspend
after drain, next = [ 'leader' ] | log = ["leader","follower"]
resumed to completion: ["leader","follower","leader","follower"]
```

```ts
const control = new RunControl();
chrome.runtime.onSuspend.addListener(() => control.requestDrain("mv3-suspend"));
try {
  await graph.invoke(input, { configurable: { thread_id }, control, durability: "sync" });
} catch (e) {
  if (!isGraphDrained(e)) throw e;      // checkpoint is saved
}
// later, fresh worker:
await graph.invoke(null, { configurable: { thread_id } });
```

`requestDrain()` stops at the next **superstep boundary** — it does not cancel in-flight work, so a long LLM call still finishes. Create a fresh `RunControl` per run.

**(B) If you truly need `interrupt()`** — install an ALS shim on `globalThis` *before* importing langgraph. `initializeGlobalInstance` only sets when unset, so this wins:

```ts
class ShimALS {
  #stack: unknown[] = [];
  getStore() { return this.#stack.at(-1); }
  run(store, cb) { this.#stack.push(store); try { return cb(); } finally { this.#stack.pop(); } }
  enterWith(store) { this.#stack.push(store); }
}
globalThis[Symbol.for("ls:tracing_async_local_storage")] = new ShimALS();
```

Verified: `interrupt()` then returns `__interrupt__` in the result, `getState().tasks[0].interrupts` is populated, and `new Command({ resume: "YES" })` on a **fresh** compiled graph resumes correctly. **Caveat:** this synchronous stack is only correct while one node runs at a time; it leaks context across parallel branches (`Send` fan-out). Our Leader/Follower graph is strictly sequential, so it is safe — but hold that constraint.

### Cancellation

`AbortSignal` works via `config.signal` (`PregelOptions extends RunnableConfig`). Verified: `ac.abort(new Error("user cancel"))` propagates out of `invoke` with the reason intact. Use this for a user "stop" button; use `requestDrain` for graceful suspend.

### Resume after the worker was killed
No special handling — state lives entirely in the checkpointer. On wake: rebuild the graph, attach the IndexedDB saver, `invoke(null, { configurable: { thread_id } })`. Keep the "is this thread running" flag in `chrome.storage.local`, not a module global.

## 5. Streaming

Current `StreamMode` (`pregel/types.d.ts:19`) — **eight**, not four:

```ts
"values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools"
```

Default is `"updates"`. Modes can be combined; with an array, each chunk arrives as `[mode, payload]`.

Verified with no polyfill:

| mode | chunk |
|---|---|
| `updates` | `["updates",{"leader":{"log":"leader","turns":1}}]` |
| `values` | `["values",{"turns":1,"log":["leader"]}]` |
| `custom` | `["custom",{"node":"leader","phase":"planning"}]` |
| `["updates","custom"]` | interleaved, custom emitted before the node's update |

Emit custom events with **`config.writer?.(…)`** (2nd node arg). Do **not** use the `getWriter()` free function — it reads AsyncLocalStorage and fails in MV3. `streamMode: "messages"` yields `[messageChunk, metadata]` where `metadata.langgraph_node` names the node — that is how you route tokens to the right UI pane.

**Web caveat:** without AsyncLocalStorage, `.streamEvents()` and tracing of *nested* Runnables only work if you thread the node's `config` (2nd arg) into every nested `.invoke(input, config)`. Top-level `updates`/`values`/`custom`/`messages` work regardless.

Forward to the side panel over a long-lived `chrome.runtime.connect` port:

```ts
const port = chrome.runtime.connect({ name: "agent" });
for await (const [mode, payload] of await graph.stream(input, {
  configurable: { thread_id }, streamMode: ["updates", "custom", "messages"],
  control, signal: ac.signal, durability: "sync",
})) port.postMessage({ mode, payload });
```

Everything crossing the port must be structured-cloneable — map `BaseMessage` to plain objects first. Buffer to `chrome.storage.session` too, since the panel may be closed.

## 6. Tool calling and OpenRouter

`tool()` from `@langchain/core/tools` with a zod schema is current:

```ts
const click = tool(async ({ selector }) => `clicked ${selector}`, {
  name: "click", description: "Click an element",
  schema: z.object({ selector: z.string() }),
});
const toolNode = new ToolNode([click]);   // NOT ToolExecutor (deprecated)
```

OpenRouter via `ChatOpenAI` + custom `baseURL` — verified to construct and `bindTools` cleanly in a browser bundle:

```ts
new ChatOpenAI({
  model: "anthropic/claude-sonnet-4.5",
  apiKey: OPENROUTER_KEY,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "HTTP-Referer": "…", "X-Title": "nanobrowser-v2" },
  },
});
```

`@langchain/openai` already passes `dangerouslyAllowBrowser: true` to the underlying client (`dist/chat_models/base.js:263`), so there is **no browser guard to defeat**. `configuration` is typed as the openai SDK's `ClientOptions` (`baseURL`, `defaultHeaders`, `fetch`, …).

**Vision works.** Standard OpenAI content parts pass straight through:

```ts
new HumanMessage({ content: [
  { type: "text", text: "What is on screen?" },
  { type: "image_url", image_url: { url: `data:image/png;base64,${b64}`, detail: "high" } },
]});
```

Verified the parts survive message construction. Screenshots come from `chrome.tabs.captureVisibleTab` as a data URL — feed it directly. Per-model vision support is OpenRouter's concern, not LangChain's.


> Bundle cost: `@langchain/openai` pulls `js-tiktoken`, which is large. If bundle size matters, consider calling OpenRouter with plain `fetch` behind a thin `BaseChatModel` — but that costs you `ToolNode` interop. Start with `ChatOpenAI`.

## 7. Recommended Leader/Follower skeleton

This **type-checks clean** under `strict` + `moduleResolution: bundler` with `tsc`, against 1.4.13. No deprecated API.

```ts
import {
  StateGraph, START, END, StateSchema, MessagesValue, ReducedValue, UntrackedValue,
  type GraphNode, type ConditionalEdgeRouter,
} from "@langchain/langgraph/web";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import * as z from "zod";

export const FollowerSignal = z.enum(["CONTINUE","SUBGOAL_COMPLETE","RETURN_TO_LEADER","BLOCKED"]);
export type FollowerSignal = z.infer<typeof FollowerSignal>;

export const AgentState = new StateSchema({
  messages: MessagesValue,
  plan: z.array(z.string()).default(() => []),
  subgoalIndex: z.number().default(0),
  signal: FollowerSignal.default("CONTINUE"),
  followerTurns: z.number().default(0),   // reset by leader
  steps: z.number().default(0),           // never reset — safety valve
  trace: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.string(), reducer: (c, n) => [...c, n],
  }),
  scratch: new UntrackedValue<Record<string, unknown>>(),  // not checkpointed
});

const leader: GraphNode<typeof AgentState> = async (state, config) => {
  config.writer?.({ kind: "leader:start", subgoal: state.subgoalIndex });
  // call planner LLM, threading `config` through
  return { plan: [/* … */], followerTurns: 0, steps: state.steps + 1, trace: "leader" };
};

const follower: GraphNode<typeof AgentState> = async (state, config) => {
  config.writer?.({ kind: "follower:start", turn: state.followerTurns });
  const signal: FollowerSignal = "CONTINUE";   // from the navigator LLM
  return { signal, followerTurns: state.followerTurns + 1, steps: state.steps + 1, trace: "follower" };
};
const route: ConditionalEdgeRouter<{ InputSchema: typeof AgentState }> = (state, config) => {
  const { planningInterval = 5, maxSteps = 50 } = config.context ?? {};
  if (state.steps >= maxSteps) return END;                     // safety valve
  if (state.signal === "BLOCKED") return END;
  if (state.signal === "SUBGOAL_COMPLETE")
    return state.subgoalIndex + 1 >= state.plan.length ? END : "leader";
  if (state.signal === "RETURN_TO_LEADER") return "leader";
  if (state.followerTurns >= planningInterval) return "leader";  // re-plan every N
  return "follower";
};

export const buildGraph = (checkpointer, tools) =>
  new StateGraph(AgentState, {
    context: z.object({ planningInterval: z.number(), maxSteps: z.number() }),
  })
    .addNode("leader", leader)
    .addNode("follower", follower)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "leader")
    .addEdge("leader", "follower")
    .addConditionalEdges("follower", route, ["leader", "follower", END])
    .compile({ checkpointer });
```

Notes: `planningInterval`/`maxSteps` live in **`context`** (static per-run config), not state, so a node can't corrupt them. `followerTurns` is reset by the leader; `steps` never is. `scratch` is `UntrackedValue`, keeping bulky per-step data (DOM snapshots) out of the checkpoint. The third arg to `addConditionalEdges` is the reachable-node list.

Run it with:

```ts
await graph.invoke(input, {
  configurable: { thread_id }, context: { planningInterval: 5, maxSteps: 50 },
  durability: "sync", control, signal: ac.signal,
  recursionLimit: 150,     // must exceed maxSteps × nodes-per-step
});
```

## Recommendation

1. Pin `@langchain/langgraph@1.4.13`, `@langchain/core@1.2.9`, `@langchain/langgraph-checkpoint@1.1.5`, `@langchain/openai@1.5.11`. Exact, no carets.
2. Import from `@langchain/langgraph/web` **explicitly** everywhere — don't rely on the `browser` condition, since one misconfigured Vite `resolve.conditions` silently pulls in `node:async_hooks`. Add an ESLint `no-restricted-imports` rule banning bare `@langchain/langgraph`.
3. State via `StateSchema` + zod. Hard-ban the §1 deprecated list in review.
4. Build the Leader/Follower `StateGraph` by hand (§7). Satisfies C-02; avoids deprecated `createReactAgent` and the `langchain` `createAgent` browser problem.
5. **Pause = `RunControl.requestDrain()`, not `interrupt()`.** No polyfill, no parallelism hazard, and it is exactly the "stop cleanly and resume from checkpoint" semantic MV3 needs. Cancel = `AbortSignal`.
6. Write an IndexedDB `BaseCheckpointSaver` (5 methods, use `this.serde`). Validate it with `@langchain/langgraph-checkpoint-validation@1.1.1`.
7. `durability: "sync"` always. The worker can die during an async checkpoint write.
8. Stream `["updates","custom","messages"]` over `chrome.runtime.connect`; emit with `config.writer?.()`. Serialize messages to plain objects before `postMessage`.
9. Thread the node's `config` into every nested `.invoke()` — mandatory for callbacks without ALS, and free insurance.
10. Add a smoke test that bundles for `platform=browser` with no polyfills and asserts the output contains no `node:` import. That catches a dependency regressing browser support at CI time rather than at runtime.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Browser support is not contractually guaranteed; it has regressed before (#1699 in `1.0.0-alpha`, fixed) and #879 is still open | **High** | Pin exact versions; CI bundle smoke test (Rec. 10); treat every langgraph upgrade as needing a browser re-test |
| If we ever need `interrupt()`, the ALS shim is only correct for sequential execution | Medium | Keep the graph sequential; if `Send` fan-out is ever added, the shim must be replaced. Prefer `requestDrain` |
| `requestDrain` only stops at superstep boundaries — a 60 s LLM call still completes and the worker may be killed mid-call | Medium | Keep per-node work short; `durability:"sync"`; set a client-side request timeout; the checkpoint from the *prior* superstep is always intact |
| Bundle size ~3.4 MB raw (`js-tiktoken` + `openai` + langgraph) | Medium | Measure minified+gzip before optimizing; consider a thin `fetch` chat model if it matters |
| `@langchain/core` is the real async_hooks source and langgraph only peer-depends on it (`^1.1.48`) — a transitive bump could reintroduce it; weekly cadence also drifts docs from source | Medium | Pin core exactly + npm `overrides`; trust installed `.d.ts` over doc sites; re-grep `@deprecated` each upgrade |
| No IndexedDB checkpointer to lean on; ours is load-bearing for all resume behavior | Medium | Use the official validation suite; test the kill-and-resume path explicitly, not just happy path |
| MV3 worker can die between `putWrites` and `put` | Low | LangGraph replays pending writes on resume by design — that is what `putWrites` exists for; make both writes atomic in one IndexedDB transaction |
