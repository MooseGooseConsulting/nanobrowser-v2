/**
 * `os` input tier (future). Will route through the host daemon (see `host/`)
 * to a Wayland virtual pointer/keyboard (`zwlr_virtual_pointer` /
 * `virtual-keyboard-unstable`), giving trusted input with no `chrome.debugger`
 * attach and no infobar at all — the mechanism
 * docs/research/bot-detection-research.md §Recommendation item 7 names as the
 * only one that closes both the low-observability row and the "no CDP
 * surface" row simultaneously, at the cost of host-level privileges outside
 * the extension sandbox.
 *
 * Not implemented here — another agent wires the daemon transport. This
 * stub exists so `selectTier`/`RunInput` callers can type against a
 * complete `InputTierName` union before that lands.
 */
import type { InputTier } from './types';

export class OsInputTier implements InputTier {
  readonly name = 'os' as const;

  attach(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  detach(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  isAttached(): boolean {
    return false;
  }

  click(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  moveTo(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  typeText(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  press(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }

  scroll(): Promise<void> {
    throw new Error('OsInputTier: not implemented');
  }
}
