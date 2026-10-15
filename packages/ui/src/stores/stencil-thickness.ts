export const STENCIL_THICKNESSES_MM = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50] as const;
export const DEFAULT_STENCIL_THICKNESS_MM = 0.20;

/** Also normalizes older/malformed persisted preferences before sending an export. */
export function stencilThicknessMm(value: unknown): number {
  return typeof value === "number" && (STENCIL_THICKNESSES_MM as readonly number[]).includes(value)
    ? value
    : DEFAULT_STENCIL_THICKNESS_MM;
}
