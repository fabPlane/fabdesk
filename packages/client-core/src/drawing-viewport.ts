export type DrawingViewport = { zoom: number; left: number; top: number; centerX?: number; centerY?: number };
/** Bounded, session-only view memory. A changed drawing never inherits old coordinates. */
export class DrawingViewportMemory {
  private entries = new Map<string, { drawing: string; viewport: DrawingViewport }>();
  constructor(private limit = 12) {}
  read(key: string, drawing: string): DrawingViewport | null {
    const saved = this.entries.get(key);
    if (!saved || saved.drawing !== drawing) return null;
    this.entries.delete(key); this.entries.set(key, saved);
    return { ...saved.viewport };
  }
  save(key: string, drawing: string, viewport: DrawingViewport): void {
    if (drawing.length > 4_000_000 || !Object.values(viewport).every(Number.isFinite) || (viewport.centerX === undefined) !== (viewport.centerY === undefined) || viewport.zoom < .2 || viewport.zoom > 64 || viewport.left < 0 || viewport.top < 0) return;
    this.entries.delete(key); this.entries.set(key, { drawing, viewport: { ...viewport } });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
