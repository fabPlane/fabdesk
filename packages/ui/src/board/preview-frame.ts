/** Coalesce input, resize and focus updates into one draw per display frame. */
export function previewFrame(draw: () => void, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let pending: number | null = null;
  return {
    render() { if (pending === null) pending = request(() => { pending = null; draw(); }); },
    dispose() { if (pending !== null) cancel(pending); pending = null; },
  };
}
