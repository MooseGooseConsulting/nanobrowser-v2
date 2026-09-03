/**
 * `in-page` input tier (R-13 default): dispatches through the page driver's
 * content-script events. `isTrusted: false`, but zero attach, zero CDP
 * surface, zero infobar — the lowest-observability tier (R-02) and the one
 * every run starts on.
 *
 * Unlike the coordinate tiers (`debugger`, `os`), this tier takes element
 * refs, not viewport points — the page driver already knows how to resolve a
 * ref to a live DOM node and dispatch a realistic event cortège on it (see
 * docs/research/trusted-input-and-stealth.md §4 hygiene rules), so there is
 * no reason to round-trip through coordinates here.
 */
import type { ClickOptions, PressOptions } from './types';

/** Opaque handle a page driver uses to name a DOM element (e.g. an a11y-tree
 * node id). This module never inspects it — it only forwards it. */
export type ElementRef = string;

/**
 * The subset of a page driver's surface this tier needs. Production wires
 * this to whatever content-script messaging module owns element refs; tests
 * inject a fake that records calls.
 */
export interface PageDriverLike {
  click(tabId: number, ref: ElementRef, opts?: ClickOptions): Promise<void>;
  moveTo?(tabId: number, ref: ElementRef): Promise<void>;
  type(tabId: number, ref: ElementRef, text: string): Promise<void>;
  press(tabId: number, ref: ElementRef | null, key: string, opts?: PressOptions): Promise<void>;
  scroll(tabId: number, ref: ElementRef, deltaX: number, deltaY: number): Promise<void>;
}

/**
 * Ref-based sibling of `InputTier` (types.ts). Both share `name` / `attach` /
 * `detach` / `isAttached`; action methods take an `ElementRef` instead of a
 * viewport point. `select.ts`'s `RunInput` façade is what lets the
 * orchestrator treat this and a coordinate tier uniformly.
 */
export interface RefInputTier {
  readonly name: 'in-page';
  attach(tabId: number): Promise<void>;
  detach(): Promise<void>;
  isAttached(): boolean;
  click(ref: ElementRef, opts?: ClickOptions): Promise<void>;
  moveTo(ref: ElementRef): Promise<void>;
  typeText(ref: ElementRef, text: string): Promise<void>;
  press(ref: ElementRef | null, key: string, opts?: PressOptions): Promise<void>;
  scroll(ref: ElementRef, deltaX: number, deltaY: number): Promise<void>;
}

export class InPageInputTier implements RefInputTier {
  readonly name = 'in-page' as const;

  private tabId: number | null = null;

  constructor(private readonly driver: PageDriverLike) {}

  async attach(tabId: number): Promise<void> {
    this.tabId = tabId;
  }

  async detach(): Promise<void> {
    this.tabId = null;
  }

  isAttached(): boolean {
    return this.tabId !== null;
  }

  private requireTab(): number {
    if (this.tabId === null) {
      throw new Error('InPageInputTier: not attached');
    }
    return this.tabId;
  }

  async click(ref: ElementRef, opts?: ClickOptions): Promise<void> {
    await this.driver.click(this.requireTab(), ref, opts);
  }

  async moveTo(ref: ElementRef): Promise<void> {
    const tabId = this.requireTab();
    if (this.driver.moveTo) await this.driver.moveTo(tabId, ref);
  }

  async typeText(ref: ElementRef, text: string): Promise<void> {
    await this.driver.type(this.requireTab(), ref, text);
  }

  async press(ref: ElementRef | null, key: string, opts?: PressOptions): Promise<void> {
    await this.driver.press(this.requireTab(), ref, key, opts);
  }

  async scroll(ref: ElementRef, deltaX: number, deltaY: number): Promise<void> {
    await this.driver.scroll(this.requireTab(), ref, deltaX, deltaY);
  }
}
