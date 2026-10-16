/** Parse and match the voice push-to-talk shortcut stored in Settings. */

export interface VoiceShortcut {
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export const DEFAULT_VOICE_SHORTCUT: VoiceShortcut = {
  key: "Space",
  alt: true,
  ctrl: false,
  meta: false,
  shift: false,
};

const MODS = ["alt", "option", "ctrl", "control", "cmd", "command", "meta", "shift"] as const;

export function parseVoiceShortcut(raw: string | null | undefined): VoiceShortcut {
  if (!raw?.trim()) return { ...DEFAULT_VOICE_SHORTCUT };
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ...DEFAULT_VOICE_SHORTCUT };
  const keyPart = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const key = normalizeKey(keyPart);
  if (!key) return { ...DEFAULT_VOICE_SHORTCUT };
  return {
    key,
    alt: mods.has("alt") || mods.has("option"),
    ctrl: mods.has("ctrl") || mods.has("control"),
    meta: mods.has("cmd") || mods.has("command") || mods.has("meta"),
    shift: mods.has("shift"),
  };
}

export function formatVoiceShortcut(shortcut: VoiceShortcut, platform?: string): string {
  const mac = platform === "darwin";
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (shortcut.alt) parts.push(mac ? "⌥" : "Alt");
  if (shortcut.shift) parts.push(mac ? "⇧" : "Shift");
  if (shortcut.meta) parts.push(mac ? "⌘" : "Meta");
  parts.push(displayKey(shortcut.key));
  return mac ? parts.join("") : parts.join("+");
}

export function matchVoiceShortcut(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  shortcut: VoiceShortcut,
): boolean {
  return (
    normalizeKey(event.key) === shortcut.key &&
    event.altKey === shortcut.alt &&
    event.ctrlKey === shortcut.ctrl &&
    event.metaKey === shortcut.meta &&
    event.shiftKey === shortcut.shift
  );
}

function normalizeKey(raw: string): string {
  if (raw === " " || /^space$/i.test(raw.trim())) return "Space";
  const k = raw.trim();
  if (!k) return "";
  if (MODS.includes(k.toLowerCase() as (typeof MODS)[number])) return "";
  if (/^esc(ape)?$/i.test(k)) return "Escape";
  if (k.length === 1) return k.toLowerCase();
  return k[0]!.toUpperCase() + k.slice(1);
}

function displayKey(key: string): string {
  if (key === "Space") return "Space";
  if (key === "Escape") return "Esc";
  return key.length === 1 ? key.toUpperCase() : key;
}
