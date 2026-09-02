import type { AuthState, Principal } from "@fabdesk/protocol";

/** Human-facing label for a signed-in principal; falls back through handle and subject. */
export function principalLabel(p: Principal | undefined, mode: AuthState["mode"]): string {
  if (p) return p.displayName?.trim() || p.handle?.trim() || p.email?.trim() || p.subject;
  return mode === "local" ? "Local user" : "Signed in";
}

/** One- or two-letter monogram for the avatar circle. */
export function principalInitials(label: string): string {
  const words = label
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[words.length - 1]!.slice(0, 1)).toUpperCase();
}
