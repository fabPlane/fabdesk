export type WorkspaceView = {
  position: [number, number, number];
  target: [number, number, number];
};

export function parseWorkspaceView(value: unknown): WorkspaceView | null {
  const v = value as WorkspaceView | null;
  const tuple = (x: unknown): x is [number, number, number] =>
    Array.isArray(x) &&
    x.length === 3 &&
    x.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7);
  if (
    !v ||
    !tuple(v.position) ||
    !tuple(v.target) ||
    Math.hypot(...v.position.map((n, i) => n - v.target[i]!)) < 0.01
  )
    return null;
  return { position: [...v.position], target: [...v.target] };
}
