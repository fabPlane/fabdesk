/** Only structured saved dimensions may supply the enclosure's size label. */
export function enclosureSizeLabel(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const box = value as Record<string, unknown>;
  const dimensions = [box.width, box.depth, box.height];
  if (!dimensions.every((number): number is number => typeof number === "number" && Number.isFinite(number) && number > 0)) return null;
  return `${dimensions.map(number => number < 0.001 ? number : Number(number.toFixed(3))).join(" × ")} mm`;
}
