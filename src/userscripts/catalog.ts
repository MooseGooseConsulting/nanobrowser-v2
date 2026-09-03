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
}

export type ValidationResult =
  | { ok: true; script: Userscript }
  | { ok: false; errors: string[] };

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

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    script: {
      id: draft.id ?? crypto.randomUUID(),
      name,
      matches: [...matches],
      code,
      updatedAt: now(),
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
 * Installs the bundled examples, but only into an empty catalog. "Empty" is the
 * only trigger: a per-script presence check would resurrect an example the user
 * edited or removed while keeping their own scripts, which is worse than the one
 * case this does allow (emptying the catalog completely re-seeds it).
 */
export async function seedDefaults(now: () => number = Date.now): Promise<Userscript[]> {
  const current = await listUserscripts();
  if (current.length > 0) return current;

  const seeded = BUNDLED_USERSCRIPTS.map((seed) => seedToScript(seed, now));
  await userscriptsItem.setValue(seeded);
  return seeded;
}
