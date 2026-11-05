/** Supported original drawing envelope. Element restoration remains the drawing library's job. */
export const MAX_EDITABLE_SKETCH_BYTES = 10 * 1024 * 1024;
export function isEditableSketchSource(text: string): boolean {
  try {
    const scene = JSON.parse(text);
    return !!scene && scene.type === "excalidraw" && scene.version === 2 && Array.isArray(scene.elements)
      && scene.elements.length <= 10_000 && scene.elements.every((element: unknown) => !!element && typeof element === "object" && !Array.isArray(element));
  } catch { return false; }
}
