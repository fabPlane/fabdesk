/**
 * A quoted KiCad s-expression string token to its value. KiCad escapes only `\"` and `\\` (and writes `\n` for a
 * newline); it keeps raw control characters such as tabs inside quotes, which JSON.parse rejects
 * ("Unterminated string"), so tokens are decoded here rather than parsed as JSON.
 */
export function kicadString(token: string): string {
  return token.slice(1, -1).replace(/\\(.)/gs, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
}
