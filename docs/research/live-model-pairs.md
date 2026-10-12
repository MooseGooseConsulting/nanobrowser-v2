# Live model pairs: what the runs say, against what the spec sheet said

**Decision, same day:** model rotation is off. Both seats are `nvidia/nemotron-3.5-lightning:free`.
`nemotron-3-ultra` stays out. The table below is why ultra was dropped; lightning itself has not
been measured on its own yet, because every lightning run so far had ultra in the leader seat.

Finding, 2026-10-12. Not a rewrite of `models-and-grounding.md` — that research picked the
defaults from published specs (largest free MoE, 1M context, `tools` + `reasoning`). This is
what the same models did on 30 real `browse` runs in the user's own Chrome on 2026-10-12.

## The numbers

Every figure below comes from `runs/history.jsonl`, scored by `scripts/harness/` from what the
run log shows the agent did. `Invalid` rows are excluded from pass rates by the scorer's own
rule; they are kept here so the sample size is not overstated.

| Pair (leader + follower) | n | valid passes | mean score | calls/run | input tokens/run |
|---|---|---|---|---|---|
| `nemotron-3-ultra-550b-a55b` + `nemotron-3.5-lightning` | 11 | 1 | 0.45 | 18 | 202k |
| `nemotron-3-ultra-550b-a55b` + `nemotron-3-super` | 3 | 2 | 0.73 | 19 | 250k |
| `laguna-s-2.1` + `laguna-s-2.1` | 9 | 3 (1 invalid) | 0.51 | 13 | 136k |
| `gemma-4-31b-it` + `gemma-4-26b-a4b-it` | 3 | 1 | 0.67 | 7 | 67k |

Ten further runs record no model id in `telemetry.byRole` and cannot be attributed yet; they
are not in this table.

## What makes nemotron-ultra the weak one, and not merely unlucky

Score alone would be thin evidence at this sample size. The tool errors inside its own runs
are the part that is not luck:

- `✖ Invalid option: expected one of "CONTINUE" | "SUBGOAL_COMPLETE" | "RETURN_TO_LEADER" | "BLOCKED"` — it emits a `signal` value that is not in the schema the harness sends it.
- `click: element is occluded at its click point by <i> [ref=e16]` repeated on the same ref, several runs in a row. The harness names the occluder and its ref precisely so the model can act on it; this one retries the same covered point.
- `type: element <button> is not a text field` — it types into a button.
- `click: unknown or stale ref: e12` — reuses refs from a snapshot that observation compaction already stubbed out (fixed 2026-10-12, see the replan-digest reset in `src/agent/graph.ts`).

That is a model that is not reliably reading the error text it is handed back, which is the
one capability the whole architecture leans on. 8 of its 11 runs answered in prose instead of
the JSON `done` schema and 10 of 11 left the reported listing ungrounded.

## The confound that has to be stated

Pair rotation is least-recently-used, and site rotation moves too, so the pairs are not
sampled on the same pages:

- nemotron-ultra ran 9 of its 11 in the 06:00 hour, i.e. mostly before the M4–M8 fixes landed.
- laguna-s-2.1 ran 6 of its 9 in the 07:00 hour, mostly after them.

So part of laguna's edge is the harness getting better, and this table cannot separate that
from the model. Anyone quoting it should quote both halves.

## What changed as a result

The cold-start pair in `scripts/live.sh` and `scripts/harness/live-tasks.mjs` is now
`laguna-s-2.1` on both seats: the better-sampled performer, at two thirds of the input
tokens. The least-recently-used rotation is unchanged — it still spreads, deliberately, per
the user's "telemetry, not a benchmark" redirect.

Nothing here blocks a user from selecting any model, free or paid, in the panel. The change is
only about what an agent-initiated run defaults to.

## What would settle it

One pair pinned with `NB_LIVE_LEADER`/`NB_LIVE_FOLLOWER`, 10 `browse` runs, then one fix to
the #51 reporting failures, then 10 more on the same sites. That is the first comparison in
this project's history with a shared page set in both halves.

**Open question:** `gemma-4-31b-it` + `gemma-4-26b-a4b-it` is the cheapest and highest-scoring
pair on paper (0.67 mean, 7 calls/run, 67k tokens/run) but n=3, and it has its own schema
defect — `wait: Received tool input did not match expected schema`, from omitting `ms`. Worth
the 10 runs before anyone promotes it.
