import type { DrcReport, DrcViolation } from "./services";

/** Compare occurrences, not error totals: fixing one error must not hide another new error. */
export function newRoutingDrcErrors(before: DrcReport, after: DrcReport): DrcViolation[] {
  const identity = (v: DrcViolation) =>
    JSON.stringify([
      v.rule,
      v.description,
      [...v.objectIds].sort(),
      v.coordinates,
      [...v.layers].sort(),
      [...v.nets].sort(),
    ]);
  const counts = new Map<string, number>();
  for (const v of before.violations.filter((v) => v.severity === "error")) {
    const key = identity(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return after.violations.filter((v) => {
    if (v.severity !== "error") return false;
    const key = identity(v),
      count = counts.get(key) ?? 0;
    if (!count) return true;
    counts.set(key, count - 1);
    return false;
  });
}
