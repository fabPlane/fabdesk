/** Compare independently measured candidates. Hard failures are never competitive. */
export type CandidateScore = {
  opens: number;
  newErrors: number;
  outsideScope: number;
  skewMm: number;
  vias: number;
  lengthMm: number;
};
export function preferCandidate(before: CandidateScore, after: CandidateScore): boolean {
  if (after.newErrors || after.outsideScope) return false;
  if (before.newErrors || before.outsideScope) return true;
  for (const key of ["opens", "newErrors", "skewMm", "vias", "lengthMm"] as const) {
    if (after[key] < before[key] - 0.000001) return true;
    if (after[key] > before[key] + 0.000001) return false;
  }
  return false;
}
