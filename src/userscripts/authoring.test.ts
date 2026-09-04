/**
 * The rails on the agent's write path (O-03). These matter more than most tests
 * here: past this point, code a model wrote runs in the user's real logged-in
 * browser, so each rail is stated as the thing it prevents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Userscript } from '@/src/messaging';
import { checkAgentMatches, writeAgentUserscript } from './authoring';
import { getUserscript, listUserscripts, saveUserscript } from './catalog';

const good = {
  name: 'chatgpt-thread-extract',
  matches: ['*://chatgpt.com/*'],
  code: 'return document.title;',
};

describe('checkAgentMatches', () => {
  it('accepts a named host and a named subdomain wildcard', () => {
    expect(checkAgentMatches(['*://chatgpt.com/*'])).toEqual([]);
    expect(checkAgentMatches(['*://*.chatgpt.com/*'])).toEqual([]);
    expect(checkAgentMatches(['https://chatgpt.com/c/*'])).toEqual([]);
  });

  it('refuses a script that would run on every site the user visits', () => {
    expect(checkAgentMatches(['<all_urls>'])[0]).toContain('matches every site');
    expect(checkAgentMatches(['*://*/*'])[0]).toContain('matches every site');
  });

  it('refuses to aim agent-written code at the local filesystem', () => {
    expect(checkAgentMatches(['file:///home/*'])[0]).toContain('may only run on http or https');
  });

  it('leaves ungrammatical patterns to the catalog rather than double-reporting them', () => {
    expect(checkAgentMatches(['not a pattern'])).toEqual([]);
  });
});

describe('writeAgentUserscript', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('stores a new script stamped as the agent\'s own', async () => {
    const result = await writeAgentUserscript(good);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.script.author).toBe('agent');
    expect(await listUserscripts()).toHaveLength(1);
  });

  it('revises a script it wrote before, in place, keeping the id', async () => {
    const first = await writeAgentUserscript(good);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await writeAgentUserscript({
      scriptId: first.script.id,
      ...good,
      code: 'return document.querySelectorAll("article").length;',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.script.id).toBe(first.script.id);
    expect(second.script.code).toContain('article');
    // Revised, not accumulated: iterating on a script must not fill the catalog.
    expect(await listUserscripts()).toHaveLength(1);
  });

  // The rail with real teeth: a user's script is work the agent did not do and
  // cannot reconstruct.
  it('refuses to overwrite a script the user wrote', async () => {
    const mine = await saveUserscript({ name: 'mine', matches: ['*://chatgpt.com/*'], code: 'return 1;' });
    expect(mine.author).toBeUndefined();

    const result = await writeAgentUserscript({ scriptId: mine.id, ...good });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('was written by the user');
    expect((await getUserscript(mine.id))?.code).toBe('return 1;');
  });

  it('refuses an all-sites allow-list and stores nothing', async () => {
    const write = vi.fn();
    const result = await writeAgentUserscript({ ...good, matches: ['<all_urls>'] }, { write });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('matches every site');
    expect(write).not.toHaveBeenCalled();
  });

  it('reports an unknown id instead of quietly creating a script under it', async () => {
    const result = await writeAgentUserscript({ scriptId: 'not-a-real-id', ...good });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('no userscript with id not-a-real-id');
    expect(await listUserscripts()).toEqual([]);
  });

  it('passes the catalog\'s own validation through, and adds its rails to it', async () => {
    const result = await writeAgentUserscript({ name: '  ', matches: ['<all_urls>'], code: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.errors.join(' | ');
    expect(joined).toContain('name must not be empty');
    expect(joined).toContain('code must not be empty');
    expect(joined).toContain('matches every site');
  });

  it('does not read the catalog at all when creating', async () => {
    const read = vi.fn<(id: string) => Promise<Userscript | undefined>>();
    const result = await writeAgentUserscript(good, { read });

    expect(result.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
