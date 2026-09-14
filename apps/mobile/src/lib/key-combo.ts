/**
 * Hardware-keyboard shortcut names. A combo is written the way it is read — "cmd+n",
 * "cmd+shift+k", "cmd+enter" — and canonicalised so that "Cmd+N", "n+cmd" and "cmd+n" register
 * as the same shortcut. The native side receives the canonical string, parses it the same way,
 * and echoes it back when the keys are pressed, so it doubles as the event id.
 *
 * "cmd" is ⌘ on iOS and iPadOS; on Android it maps to Ctrl (the Meta key exists on Android
 * keyboards but is rarely bound the way ⌘ is), so one binding reads naturally on both.
 */
export const MODIFIERS = ["ctrl", "alt", "shift", "cmd"] as const;
export type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Named keys, so a binding never has to spell "\r". */
const KEY_ALIASES: Record<string, string> = {
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

export interface KeyCombo {
  key: string;
  modifiers: Modifier[];
}

/** Parses a combo; `null` when it has no key, an unknown modifier, or a multi-character key. */
export function parseCombo(input: string): KeyCombo | null {
  const parts = input
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers = new Set<Modifier>();
  let key: string | null = null;
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part];
    if (mod) {
      modifiers.add(mod);
      continue;
    }
    if (key !== null) return null;
    const named = KEY_ALIASES[part];
    if (named) key = named;
    else if (part.length === 1) key = part;
    else return null;
  }
  if (key === null) return null;
  return { key, modifiers: MODIFIERS.filter((m) => modifiers.has(m)) };
}

/** The canonical spelling: modifiers in a fixed order, then the key, all lower-case. */
export function normalizeCombo(input: string): string | null {
  const parsed = parseCombo(input);
  return parsed ? [...parsed.modifiers, parsed.key].join("+") : null;
}
