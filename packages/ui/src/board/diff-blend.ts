/** Fade the two revision groups without changing their shared coordinate system. */
export function blendDiffOverlay(svg: string, percent: number): string {
  const to = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 50)) / 100;
  return svg.replace(/<g\b[^>]*\bclass="board-diff-(removed|added)"[^>]*>/g, (tag, kind: string) =>
    tag.replace(/\sopacity="[^"]*"/, ` opacity="${kind === "removed" ? 1 - to : to}"`),
  );
}
