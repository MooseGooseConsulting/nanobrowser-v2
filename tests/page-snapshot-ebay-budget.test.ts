// @vitest-environment jsdom
/**
 * Task: measure whether `snapshot()`'s historical default `maxNodes` (400) captures
 * every result title on a 60-listing eBay search page, and report the real number
 * needed. See `DEFAULT_MAX_NODES` in src/page/snapshot.ts for what changed and why.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_NODES, snapshot } from '@/src/page/snapshot';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-current.html');
const HISTORICAL_DEFAULT = 400;

function mountFixture(): void {
  document.body.innerHTML = readFileSync(FIXTURE, 'utf8');
}

/** The 60 real listings' item ids, in DOM order (see the fixture's own generator comment). */
const ITEM_IDS = Array.from({ length: 60 }, (_, i) => 158192070642 + i);

describe('snapshot maxNodes budget on the eBay current-offerings fixture', () => {
  it('measures the real, untruncated node count this page needs', () => {
    mountFixture();
    const full = snapshot({ maxNodes: 100_000 });
    expect(full.truncated).toBe(false);
    // Measured: 553 nodes for 60 real listings + 2 "Shop on eBay" placeholders plus
    // the page's header/nav chrome. This is the number DEFAULT_MAX_NODES is judged
    // against — see the comment there for the margin taken above it.
    expect(full.nodes).toBe(553);
    for (const id of ITEM_IDS) expect(full.text).toContain(`itm/${id}`);
  });

  it('the historical default of 400 nodes truncates before the last listings', () => {
    mountFixture();
    const capped = snapshot({ maxNodes: HISTORICAL_DEFAULT });
    expect(capped.truncated).toBe(true);
    // The first listings are still there...
    expect(capped.text).toContain(`itm/${ITEM_IDS[0]}`);
    // ...but the walk runs out of budget before the last ones (measured: the last
    // ~16 of 60 listings never appear at maxNodes:400 on this fixture).
    expect(capped.text).not.toContain(`itm/${ITEM_IDS.at(-1)}`);
  });

  it('the current default captures every one of the 60 result titles', () => {
    mountFixture();
    const result = snapshot();
    expect(result.truncated).toBe(false);
    for (const id of ITEM_IDS) expect(result.text).toContain(`itm/${id}`);
  });

  it('the current default carries real headroom over the measured requirement', () => {
    // DEFAULT_MAX_NODES must exceed the measured full walk (553) with margin: the
    // real eBay page carries filter sidebars and related-searches chrome this
    // fixture does not model.
    expect(DEFAULT_MAX_NODES).toBeGreaterThan(553);
  });
});
