/**
 * Input injection slot.
 *
 * R-13 makes input fidelity escalatable. The host-side rung of that ladder is
 * OS-level injection (Wayland / uinput), which is deliberately NOT implemented
 * here -- this module only fixes the shape so the dispatcher can be wired now and
 * a real injector dropped in later without a protocol change.
 */

export type MouseButton = 'left' | 'right' | 'middle';
export type KeyAction = 'down' | 'up' | 'press';

export interface InputInjector {
  readonly name: string;
  moveTo(x: number, y: number): Promise<void>;
  click(button: MouseButton): Promise<void>;
  typeText(text: string): Promise<void>;
  key(name: string, action: KeyAction): Promise<void>;
}

export class UnsupportedInputError extends Error {
  constructor(op: string) {
    super(`input injection is not available in this build (${op})`);
  }
}

/** The default. Accepts nothing; every call rejects so callers cannot silently no-op. */
export class NullInjector implements InputInjector {
  readonly name = 'null';
  async moveTo(_x: number, _y: number): Promise<void> {
    throw new UnsupportedInputError('moveTo');
  }
  async click(_button: MouseButton): Promise<void> {
    throw new UnsupportedInputError('click');
  }
  async typeText(_text: string): Promise<void> {
    throw new UnsupportedInputError('typeText');
  }
  async key(_name: string, _action: KeyAction): Promise<void> {
    throw new UnsupportedInputError('key');
  }
}

let current: InputInjector = new NullInjector();

export function getInjector(): InputInjector {
  return current;
}

/** Seam for the agent that will implement Wayland/uinput injection. */
export function setInjector(injector: InputInjector): void {
  current = injector;
}
