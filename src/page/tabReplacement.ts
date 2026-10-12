/**
 * Chrome swaps a tab's id when it activates a prerendered page or finishes certain
 * redirect chains (`chrome.tabs.onReplaced`). A run holds the id it started with, so
 * after a swap every page op failed with "No tab with id": a live eBay run died this
 * way two steps in, right after eBay's bot-challenge page redirected to the results.
 *
 * This records each replacement so callers can follow an old id to the tab that now
 * shows the page. It is module state on purpose: the run manager, the page driver and
 * the userscript runner all hold the original id independently.
 */

const replacedBy = new Map<number, number>();

/** The id that currently stands for `tabId`, following any chain of replacements. */
export function currentTabId(tabId: number): number {
  let id = tabId;
  const seen = new Set<number>();
  while (replacedBy.has(id) && !seen.has(id)) {
    seen.add(id);
    id = replacedBy.get(id)!;
  }
  return id;
}

export function recordTabReplaced(addedTabId: number, removedTabId: number): void {
  if (addedTabId !== removedTabId) replacedBy.set(removedTabId, addedTabId);
}

export interface TabReplacedEvent {
  addListener(fn: (addedTabId: number, removedTabId: number) => void): void;
}

const tracked = new WeakSet<TabReplacedEvent>();

/** Subscribe once per event source; later calls with the same source do nothing. */
export function trackTabReplacements(onReplaced: TabReplacedEvent | undefined): void {
  if (!onReplaced || tracked.has(onReplaced)) return;
  tracked.add(onReplaced);
  onReplaced.addListener(recordTabReplaced);
}

/** Test seam: forget every recorded replacement. */
export function resetTabReplacements(): void {
  replacedBy.clear();
}
