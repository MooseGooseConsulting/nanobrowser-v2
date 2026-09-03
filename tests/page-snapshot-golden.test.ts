// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRef, snapshot } from '@/src/page/snapshot';

// `import.meta.url` is an http: URL under the jsdom environment, so resolve from the
// project root that vitest already runs in.
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/page-hyperagent-threads.html');

/**
 * Golden text for the whole serializer. If this changes, the Follower's prompt changes —
 * so the diff has to be looked at, not blessed.
 */
const EXPECTED = [
  '- navigation "Threads" [ref=e1]',
  '  - heading "Threads" [ref=e2] {level=2}',
  '  - text "Filter threads"',
  '  - searchbox "Filter threads" [ref=e3] {type=search value="deploy" placeholder="Search threads"}',
  '  - list [ref=e4]',
  '    - listitem [ref=e5]',
  '      - link "Ship the MV3 rewrite" [ref=e6] {href=/threads/1}',
  '      - text "running"',
  '    - listitem [ref=e7]',
  '      - link "Audit isTrusted fallbacks" [ref=e8] {href=/threads/2}',
  '      - text "blocked"',
  '  - button "New thread" [ref=e9]',
  '  - button "Archive selected" [ref=e10] {disabled=true}',
  '- main [ref=e11]',
  '  - heading "Ship the MV3 rewrite" [ref=e12] {level=1}',
  '  - text "Follower returned RETURN_TO_LEADER after two subgoals."',
  '  - combobox "Observe mode" [ref=e13] {value="dom" options=3}',
  '  - textbox "Reply" [ref=e14] {value="Looks good."}',
].join('\n');

function mountFixture(): void {
  document.body.innerHTML = readFileSync(FIXTURE, 'utf8');
}

describe('golden snapshot of a Hyperagent-like thread sidebar', () => {
  it('serialises to the expected text', () => {
    mountFixture();
    expect(snapshot().text).toBe(EXPECTED);
  });

  it('stays far inside the token budget for a page of this size', () => {
    mountFixture();
    const result = snapshot();
    expect(result.nodes).toBe(18);
    expect(result.truncated).toBe(false);
    expect(result.approxTokens).toBeLessThan(500);
  });

  it('omits the display:none thread and the aria-hidden "+" decoration', () => {
    mountFixture();
    const text = snapshot().text;
    expect(text).not.toContain('Archived thread');
    expect(text).not.toContain('"+"');
  });

  it('hands back refs that resolve to the right live elements', () => {
    mountFixture();
    snapshot();
    expect((resolveRef('e6') as HTMLAnchorElement).getAttribute('href')).toBe('/threads/1');
    expect((resolveRef('e3') as HTMLInputElement).id).toBe('q');
    expect((resolveRef('e13') as HTMLSelectElement).localName).toBe('select');
  });

  it('interactiveOnly keeps every actionable row and nothing else', () => {
    mountFixture();
    expect(snapshot({ interactiveOnly: true }).text).toBe(
      [
        '- searchbox "Filter threads" [ref=e1] {type=search value="deploy" placeholder="Search threads"}',
        '- link "Ship the MV3 rewrite" [ref=e2] {href=/threads/1}',
        '- link "Audit isTrusted fallbacks" [ref=e3] {href=/threads/2}',
        '- button "New thread" [ref=e4]',
        '- button "Archive selected" [ref=e5] {disabled=true}',
        '- combobox "Observe mode" [ref=e6] {value="dom" options=3}',
        '- textbox "Reply" [ref=e7] {value="Looks good."}',
      ].join('\n'),
    );
  });
});
