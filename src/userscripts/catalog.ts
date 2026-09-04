/**
 * The userscript catalog: CRUD over one WXT storage item (R-09/R-10).
 *
 * Stored shape is `Userscript[]` from the shared contract — the panel lists what is
 * here, and the runner only ever injects code that came from here (or a debug
 * override of it), so this is also where the per-script allow-list is validated.
 */
import { storage } from '#imports';
import type { Userscript } from '@/src/messaging';
import { isValidMatchPattern } from './match-pattern';
import { BUNDLED_USERSCRIPTS, type UserscriptSeed } from './examples';

export const userscriptsItem = storage.defineItem<Userscript[]>('local:userscripts', {
  fallback: [],
  version: 1,
});

/** A draft as it arrives from the panel: `id`/`updatedAt` may be absent on create. */
export interface UserscriptDraft {
  id?: string;
  name: string;
  matches: string[];
  code: string;
  updatedAt?: number;
  /** Absent means the user wrote it; see {@link Userscript.author}. */
  author?: 'user' | 'agent';
}

export type ValidationResult =
  | { ok: true; script: Userscript }
  | { ok: false; errors: string[] };

/**
 * Ceiling on stored userscript source. `chrome.userScripts.execute()` takes the
 * whole body inline (docs/research/userscripts-api.md); nothing upstream caps
 * it, so an unbounded script would be handed whole to the injector and stored
 * whole in `local:userscripts`. 256 KiB is generous for a hand-written script
 * and small enough to keep storage and injection bounded.
 */
export const MAX_CODE_BYTES = 256 * 1024;

/**
 * Validates and normalises a draft. Names are trimmed, match patterns are checked
 * against the real grammar, and code must be non-empty — a script that cannot be
 * targeted or has nothing to run is never worth storing.
 */
export function validateUserscript(draft: UserscriptDraft, now: () => number = Date.now): ValidationResult {
  const errors: string[] = [];

  const name = typeof draft?.name === 'string' ? draft.name.trim() : '';
  if (name.length === 0) errors.push('name must not be empty');

  const matches = Array.isArray(draft?.matches) ? draft.matches : [];
  if (matches.length === 0) {
    errors.push('matches must list at least one match pattern');
  } else {
    for (const pattern of matches) {
      if (!isValidMatchPattern(pattern)) errors.push(`invalid match pattern: ${JSON.stringify(pattern)}`);
    }
  }

  const code = typeof draft?.code === 'string' ? draft.code : '';
  if (code.trim().length === 0) errors.push('code must not be empty');
  else if (code.length > MAX_CODE_BYTES) {
    errors.push(`code exceeds the ${MAX_CODE_BYTES}-byte limit (${code.length} bytes)`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    script: {
      id: draft.id ?? crypto.randomUUID(),
      name,
      matches: [...matches],
      code,
      updatedAt: now(),
      ...(draft.author === 'agent' ? { author: 'agent' as const } : {}),
    },
  };
}

export async function listUserscripts(): Promise<Userscript[]> {
  return userscriptsItem.getValue();
}

export async function getUserscript(id: string): Promise<Userscript | undefined> {
  return (await listUserscripts()).find((script) => script.id === id);
}

/**
 * Creates or replaces a script. An unknown (or absent) id creates; a known id
 * replaces in place, keeping list order stable so the panel does not reshuffle.
 * Throws on invalid input rather than storing something the runner would refuse.
 */
export async function saveUserscript(draft: UserscriptDraft, now: () => number = Date.now): Promise<Userscript> {
  const validated = validateUserscript(draft, now);
  if (!validated.ok) throw new Error(`invalid userscript: ${validated.errors.join('; ')}`);

  const script = validated.script;
  const current = await listUserscripts();
  const index = current.findIndex((existing) => existing.id === script.id);
  const next = index >= 0 ? current.map((existing, i) => (i === index ? script : existing)) : [...current, script];
  await userscriptsItem.setValue(next);
  return script;
}

/** Removes a script. Returns whether anything was actually removed. */
export async function deleteUserscript(id: string): Promise<boolean> {
  const current = await listUserscripts();
  const next = current.filter((script) => script.id !== id);
  if (next.length === current.length) return false;
  await userscriptsItem.setValue(next);
  return true;
}

export async function clearUserscripts(): Promise<void> {
  await userscriptsItem.removeValue();
}

function seedToScript(seed: UserscriptSeed, now: () => number): Userscript {
  return { id: crypto.randomUUID(), name: seed.name, matches: [...seed.matches], code: seed.code, updatedAt: now() };
}

/**
 * Names of bundled examples this profile has already been offered.
 *
 * Presence in the catalog cannot answer that question: a user who deleted an
 * example looks identical to one who never received it. Recording the offer
 * separately lets a NEW bundled script reach an existing install without
 * resurrecting one the user threw away.
 */
export const seededNamesItem = storage.defineItem<string[]>('local:userscripts.seeded', {
  fallback: [],
  version: 1,
});

/**
 * Installs any bundled example this profile has not been offered before.
 *
 * The first version of this seeded only into an empty catalog, which meant a
 * newly bundled script never reached anyone who already had one -- the eBay
 * extractor was invisible on a profile that had been running since before it
 * existed. Deleted and edited examples still stay gone, because the decision is
 * made from the offer record rather than from the catalog's contents.
 */
export async function seedDefaults(now: () => number = Date.now): Promise<Userscript[]> {
  const current = await listUserscripts();
  const offered = new Set(await seededNamesItem.getValue());

  // A pre-existing catalog from before the offer record was kept: treat whatever
  // is in it as already offered, so nothing the user removed comes back.
  if (offered.size === 0 && current.length > 0) {
    for (const script of current) offered.add(script.name);
  }

  const missing = BUNDLED_USERSCRIPTS.filter((seed) => !offered.has(seed.name));
  if (missing.length === 0) {
    await seededNamesItem.setValue([...offered]);
    return current;
  }

  const next = [...current, ...missing.map((seed) => seedToScript(seed, now))];
  await userscriptsItem.setValue(next);
  await seededNamesItem.setValue([...offered, ...missing.map((seed) => seed.name)]);
  return next;
}
