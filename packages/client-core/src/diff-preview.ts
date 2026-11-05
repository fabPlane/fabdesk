/** The generated legend belongs in the UI, where it can wrap without clipping board geometry. */
export function diffPreviewSvg(source: string): string {
  if (!/<svg\b[^>]*\bdata-board-diff=["'](?:pcb|schematic)["']/.test(source)) return source;
  return source.replace(/<text\b[^>]*>(?:PCB|Schematic) · green added · red removed · amber moved\/changed<\/text>/g, "");
}
