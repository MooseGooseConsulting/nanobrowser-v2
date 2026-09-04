/**
 * Which models a run is allowed to use.
 *
 * The user authorised free OpenRouter models only, and said so after a run was
 * made on a paid pair without asking: "i didn't authorize a paid pair... just
 * use the free nemotron pair". Spending their credit is not reversible, so this
 * is enforced in the run path rather than left to the panel's defaults --
 * `nb-run --option leaderModel=...` bypasses the panel entirely.
 *
 * The escape hatch is deliberate but explicit: a run may pass
 * `--option allowPaidModels=true`. Nothing sets it by default, so a paid model
 * can only ever be reached by someone typing the words.
 */

/**
 * A model id is free when OpenRouter's `:free` endpoint suffix is present.
 *
 * The catalog also carries a `free` flag derived from pricing
 * (`mapOpenRouterModel` in src/host/native.ts), but the policy check runs in the
 * worker before any catalog fetch and must not depend on the host being
 * reachable. The suffix is the same thing OpenRouter routes on, and it is the
 * only part of the id the user can see in the run command.
 */
export function isFreeModelId(model: string): boolean {
  return model.endsWith(':free');
}

export interface ModelPolicyInput {
  leaderModel: string;
  followerModel: string;
}

export type ModelPolicyResult = { ok: true } | { ok: false; reason: string };

/**
 * Refuses a run whose Leader or Follower is a paid model.
 *
 * Returns rather than throws: the worker turns this into an ordinary
 * `run.ended` with status `error`, so the CLI and the panel both surface the
 * reason instead of an unhandled rejection.
 */
export function checkModelPolicy(
  config: ModelPolicyInput,
  options?: { allowPaid?: boolean },
): ModelPolicyResult {
  if (options?.allowPaid) return { ok: true };

  const paid: string[] = [];
  if (config.leaderModel && !isFreeModelId(config.leaderModel)) {
    paid.push(`leader "${config.leaderModel}"`);
  }
  if (config.followerModel && !isFreeModelId(config.followerModel)) {
    paid.push(`follower "${config.followerModel}"`);
  }
  if (paid.length === 0) return { ok: true };

  return {
    ok: false,
    reason:
      `refusing to spend credit: ${paid.join(' and ')} ${paid.length === 1 ? 'is' : 'are'} not a free ` +
      'OpenRouter model. Only ":free" models are authorised. Pass ' +
      '--option allowPaidModels=true to override for one run.',
  };
}

/** Reads the run option that lifts the policy for a single run. */
export function allowPaidFromOptions(options?: Record<string, unknown>): boolean {
  const raw = options?.allowPaidModels;
  return raw === true || raw === 'true' || raw === '1';
}
