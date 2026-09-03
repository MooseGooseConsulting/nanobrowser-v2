/**
 * Input tier contract (R-13). Coordinates passed to any `InputTier` are CSS
 * pixels in the tab's viewport — the same space `getBoundingClientRect()`
 * reports in, not device pixels and not page/document coordinates.
 *
 * Three tiers implement this:
 * - `in-page` (default, R-13): content-script event dispatch. `isTrusted: false`.
 * - `debugger`: `chrome.debugger` + CDP `Input.*`. `isTrusted: true`. Raises the
 *   Chrome debugging infobar — see docs/research/trusted-input-and-stealth.md.
 * - `os`: routes to the host daemon's OS-level pointer/keyboard injection.
 *   Stub only; see os.ts.
 */

export type InputTierName = 'in-page' | 'debugger' | 'os';

/** Mouse buttons an `InputTier` can click with. */
export type MouseButton = 'left' | 'right' | 'middle';

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
}

/** Modifier bitmask, CDP-compatible: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
export interface KeyModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface PressOptions {
  modifiers?: KeyModifiers;
}

/**
 * One escalation tier's capability to deliver input to a tab. All coordinate
 * arguments are CSS pixels in the tab viewport. Implementations are async
 * throughout so a tier can pace or await protocol round-trips internally.
 */
export interface InputTier {
  readonly name: InputTierName;

  /** Attach this tier to a tab for the run segment. Idempotent while attached. */
  attach(tabId: number): Promise<void>;

  /** Detach from the current tab, if attached. Idempotent. */
  detach(): Promise<void>;

  /** True while attached to a tab and able to deliver input. */
  isAttached(): boolean;

  /** Click at a viewport point. */
  click(x: number, y: number, opts?: ClickOptions): Promise<void>;

  /** Move the pointer to a viewport point via a humanized path. */
  moveTo(x: number, y: number): Promise<void>;

  /** Type literal text, one dispatched keystroke at a time. */
  typeText(text: string): Promise<void>;

  /** Press one named key (see debugger.ts's NAMED_KEYS for the supported set). */
  press(key: string, opts?: PressOptions): Promise<void>;

  /** Scroll at a viewport point by (deltaX, deltaY) CSS pixels. */
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
}
