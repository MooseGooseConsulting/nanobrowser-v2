/**
 * The agent's own write path into the catalog (R-09/R-10, O-03).
 *
 * O-03 asked what "the agent can debug userscripts live" includes. The answer the
 * user gave on 2026-09-04 is *the agent writes and iterates scripts*: it authors
 * the code, runs it, reads the console and the error, and revises. Breakpoints are
 * explicitly out — they would need `chrome.debugger`, whose permanent infobar is a
 * hard failure of R-02.
 *
 * That makes this module the boundary where model-written code becomes something
 * that will execute in the user's real, logged-in browser, so the rails live here
 * rather than in the tool description, where a model may simply not comply:
 *
 *   1. **A concrete host.** `<all_urls>` and a bare `*` host are refused. The agent
 *      has to name where its code runs; `*.example.com` is fine, "everywhere" is
 *      not. Without this the agent could leave behind a standing script that runs
 *      on the user's bank.
 *   2. **http/https only.** No `file://`, so agent-written code cannot be aimed at
 *      the local filesystem.
 *   3. **Never overwrite a human's script.** Updating by id requires that the
 *      stored script was itself agent-written. The user's own scripts are theirs.
 *
 * Everything else — name, pattern grammar, code size — is the catalog's ordinary
 * validation, reused rather than restated.
 */
import type { Userscript } from '@/src/messaging';
import { getUserscript, saveUserscript, validateUserscript, type UserscriptDraft } from './catalog';
import { parseMatchPattern } from './match-pattern';

/** Schemes an agent-authored script may target. */
export const AGENT_ALLOWED_SCHEMES = ['http', 'https'] as const;

export interface AgentScriptRequest {
  /** Omit to create. Give the id of an agent-written script to revise it. */
  scriptId?: string;
  name: string;
  matches: string[];
  code: string;
}

export type AgentWriteResult =
  | { ok: true; script: Userscript; created: boolean }
  | { ok: false; errors: string[] };

/**
 * Checks the allow-list an agent asked for against rails 1 and 2. Returns the
 * problems, empty when the patterns are acceptable.
 *
 * Grammar errors are left to {@link validateUserscript}: reporting "invalid match
 * pattern" twice, in two different wordings, helps nobody.
 */
export function checkAgentMatches(matches: string[]): string[] {
  const errors: string[] = [];
  for (const pattern of matches) {
    const parsed = parseMatchPattern(pattern);
    if (!parsed) continue;

    if (parsed.host === '*') {
      errors.push(
        `${JSON.stringify(pattern)} matches every site. Name the host you mean, ` +
          'e.g. "*://example.com/*" or "*://*.example.com/*".',
      );
      continue;
    }

    const disallowed = parsed.schemes.filter(
      (scheme) => !(AGENT_ALLOWED_SCHEMES as readonly string[]).includes(scheme),
    );
    if (disallowed.length > 0) {
      errors.push(
        `${JSON.stringify(pattern)} targets ${disallowed.join(', ')}; a script you write may only run on http or https.`,
      );
    }
  }
  return errors;
}

export interface AgentWriteDeps {
  read?: (id: string) => Promise<Userscript | undefined>;
  write?: (draft: UserscriptDraft, now?: () => number) => Promise<Userscript>;
  now?: () => number;
}

/**
 * Creates or revises an agent-authored script. Returns the problems rather than
 * throwing, because the caller is a tool whose whole purpose is to hand the model
 * something it can act on — a rejected write is one turn of the loop, not a crash.
 */
export async function writeAgentUserscript(
  request: AgentScriptRequest,
  deps: AgentWriteDeps = {},
): Promise<AgentWriteResult> {
  const read = deps.read ?? getUserscript;
  const write = deps.write ?? saveUserscript;

  const matches = Array.isArray(request?.matches) ? request.matches : [];
  const draft: UserscriptDraft = {
    ...(request.scriptId ? { id: request.scriptId } : {}),
    name: request?.name ?? '',
    matches,
    code: request?.code ?? '',
    author: 'agent',
  };

  // Grammar and size first, so a nonsense pattern is reported as nonsense rather
  // than as a policy violation.
  const validated = validateUserscript(draft, deps.now);
  const errors = validated.ok ? [] : [...validated.errors];
  errors.push(...checkAgentMatches(matches));

  let created = true;
  if (request.scriptId) {
    const existing = await read(request.scriptId);
    if (!existing) {
      errors.push(
        `no userscript with id ${request.scriptId}. Omit scriptId to create a new one.`,
      );
    } else if (existing.author !== 'agent') {
      // Rail 3. The user's scripts are the user's; silently rewriting one would
      // destroy work with no record of what it used to be.
      errors.push(
        `${request.scriptId} ("${existing.name}") was written by the user and cannot be ` +
          'overwritten. Omit scriptId to create your own script instead.',
      );
    } else {
      created = false;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, script: await write(draft, deps.now), created };
}
