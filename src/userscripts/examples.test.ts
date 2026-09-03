// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads" }
import { beforeEach, describe, expect, it } from 'vitest';
import { HYPERAGENT_OBSERVE } from './examples';
import { resetWorldConfiguration, runUserscript } from './runner';
import { vmUserScriptsApi } from './testing';

/** A thread list shaped like the page the example observes. */
const THREAD_LIST = `
<main>
  <ul class="thread-list">
    <li class="thread-row" data-thread-id="t-1">
      <a class="thread-title" href="/thread/t-1">Refactor the parser</a>
      <span class="status-badge" data-status="running">running (agent)</span>
    </li>
    <li class="thread-row" data-thread-id="t-2">
      <a class="thread-title" href="/thread/t-2">Ship   the   side panel</a>
      <span class="status-badge" data-status="waiting">waiting for you</span>
    </li>
    <li class="thread-row" data-thread-id="t-3">
      <a class="thread-title" href="/thread/t-3">Nightly crawl</a>
      <span class="badge">idle</span>
    </li>
  </ul>
</main>
`;

const observe = {
  id: 'hyperagent-observe',
  name: HYPERAGENT_OBSERVE.name,
  matches: [...HYPERAGENT_OBSERVE.matches],
  code: HYPERAGENT_OBSERVE.code,
  updatedAt: 0,
};

describe('bundled hyperagent-observe example', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.body.innerHTML = THREAD_LIST;
  });

  it('returns every thread title and status badge as JSON', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      scriptId: 'hyperagent-observe',
      ok: true,
      readOnly: true,
      host: 'hyperagent.com',
      path: '/threads',
      threadCount: 3,
      threads: [
        { id: 't-1', title: 'Refactor the parser', status: 'running' },
        { id: 't-2', title: 'Ship the side panel', status: 'waiting' },
        // No data-status: the badge's own text is the status.
        { id: 't-3', title: 'Nightly crawl', status: 'idle' },
      ],
    });
  });

  it('writes nothing to the page and logs nothing', async () => {
    const before = document.body.innerHTML;
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(document.body.innerHTML).toBe(before);
    expect(result.console).toEqual([]);
  });

  it('reports an empty thread list rather than failing', async () => {
    document.body.innerHTML = '<main><p>No threads yet.</p></main>';
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ ok: true, threadCount: 0, threads: [] });
  });

  it('is allow-listed to hyperagent.com only', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://example.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this script's allow-list/);
  });
});
