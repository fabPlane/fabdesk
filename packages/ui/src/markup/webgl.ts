const presenters = new WeakMap<HTMLCanvasElement, () => void>();

/** 3D/CAD views register a synchronous present so markup can snapshot with preserveDrawingBuffer:false. */
export function bindMarkupWebglCanvas(canvas: HTMLCanvasElement, present: () => void): void {
  presenters.set(canvas, present);
}

export function unbindMarkupWebglCanvas(canvas: HTMLCanvasElement): void {
  presenters.delete(canvas);
}

export function presentMarkupWebglCanvas(canvas: HTMLCanvasElement): void {
  presenters.get(canvas)?.();
}
