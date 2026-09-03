/**
 * Graph state and run context.
 *
 * `StateSchema` + zod, per `docs/research/langgraph.md` §1 — `Annotation.Root`,
 * `StateGraphArgs` channels and `stateSchema:` are all deprecated (C-03).
 *
 * The Leader and the Follower keep SEPARATE message histories. They are two
 * roles with two models, two system prompts and two vocabularies (R-03); a
 * shared transcript would leak every DOM snapshot into the planner's context and
 * every plan revision into the navigator's.
 *
 * Anything that is fixed for the whole run — `planningInterval`, `maxSteps`,
 * `observe`, the model handles, the page port — lives in the run *context*, not
 * in state, so no node can corrupt it and none of it is checkpointed.
 */
import * as z from 'zod';
import { ReducedValue, StateSchema, messagesStateReducer } from '@langchain/langgraph/web';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ObserveMode } from '@/src/storage';
import { FollowerSignalSchema, type PageTools, type PageToolset } from './tools';

/** Terminal states the graph itself can reach. `aborted` is owned by `run.ts`. */
export const RunStatusSchema = z.enum(['running', 'done', 'blocked', 'max-steps', 'error']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * One chat history channel, shaped exactly like langgraph's own `MessagesValue`
 * but instantiated per role so the two histories never share a channel.
 */
function messageHistory(): ReducedValue<BaseMessage[], unknown> {
  return new ReducedValue<BaseMessage[], unknown>(
    z.custom<BaseMessage[]>().default(() => []),
    {
      inputSchema: z.custom<unknown>(),
      reducer: (current, next) =>
        messagesStateReducer(
          current as never,
          next as never,
        ),
      jsonSchemaExtra: { langgraph_type: 'messages' },
    },
  );
}

export const AgentState = new StateSchema({
  /** The planner's own transcript. Never sees raw page observations. */
  leaderMessages: messageHistory(),
  /** The navigator's own transcript. Holds observations and tool results. */
  followerMessages: messageHistory(),
  /** Free-text plan, as written by the Leader (R-07 shows it in the log). */
  plan: z.string().default(''),
  /** Ordered subgoals the plan decomposes into. */
  subgoals: z.array(z.string()).default(() => []),
  /** Zero-based index into `subgoals` of the one the Follower is working on. */
  currentSubgoal: z.number().int().min(0).default(0),
  /** Follower action steps taken. Never reset — this is the R-04 safety valve's counter. */
  stepCount: z.number().int().min(0).default(0),
  /** Follower action steps since the last Leader turn. Reset by the Leader (R-04). */
  stepsSinceReplan: z.number().int().min(0).default(0),
  /** The Follower's most recent self-classification (R-03). */
  lastSignal: FollowerSignalSchema.nullable().default(null),
  status: RunStatusSchema.default('running'),
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;

/**
 * Static per-run context. Model handles and the page port are passed as opaque
 * values: they are behaviour, not data, and must never reach a checkpoint.
 */
export const AgentContextSchema = z.object({
  /** The user's objective, verbatim. */
  objective: z.string(),
  /** R-04: deterministic Leader cadence, in Follower steps. */
  planningInterval: z.number().int().min(1),
  /** R-04: safety valve, not the normal handoff. */
  maxSteps: z.number().int().min(1),
  /** R-08: the user's choice in the side panel. */
  observe: z.custom<ObserveMode>(),
  leaderModel: z.custom<BaseChatModel>(),
  followerModel: z.custom<BaseChatModel>(),
  toolset: z.custom<PageToolset>(),
  page: z.custom<PageTools>(),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
