export type QualityMode = "gate" | "observe";
export type RegressionTier = "pr" | "nightly";

export interface RegressionCase {
  id: string;
  tier: RegressionTier;
  netlist: string;
  placement?: string;
  quality: QualityMode;
  routeTimeoutMs: number;
  hardTimeoutMs: number;
  requireAllRouted?: boolean;
  forbidIntroducedRules?: string[];
}

export interface RegressionManifest {
  schema: 1;
  cases: RegressionCase[];
}

export interface DrcViolation {
  rule: string;
  severity: "error" | "warning" | "exclusion";
  signature?: string;
}

export interface DrcReport {
  violations: DrcViolation[];
  unconnected: DrcViolation[];
  schematicParity: DrcViolation[];
  counts: { errors: number; warnings: number; unconnected: number };
}

export interface RouteObservation {
  timedOut: boolean;
  unrouted: unknown[];
  elapsedMs?: number;
}

export interface CaseEvaluation {
  failures: string[];
  observations: string[];
  introducedErrors: Record<string, number>;
}

function errorCounts(report: DrcReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of [...report.violations, ...report.schematicParity]) {
    if (violation.severity !== "error") continue;
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  }
  return counts;
}

/** DRC errors added by routing. Errors already present after placement are not blamed on the router. */
export function introducedDrcErrors(before: DrcReport, after: DrcReport): Record<string, number> {
  const pre = errorCounts(before);
  const post = errorCounts(after);
  const out: Record<string, number> = {};
  for (const [rule, count] of post) {
    const added = Math.max(0, count - (pre.get(rule) ?? 0));
    if (added) out[rule] = added;
  }
  return out;
}

export function evaluateCase(
  spec: RegressionCase,
  before: DrcReport,
  after: DrcReport,
  route: RouteObservation,
  livenessFailures: string[] = [],
): CaseEvaluation {
  const failures = [...livenessFailures];
  const observations: string[] = [];
  const introducedErrors = introducedDrcErrors(before, after);

  if (route.timedOut) {
    const message = "router reported a timeout";
    if (spec.quality === "gate") failures.push(message);
    else observations.push(message);
  }
  if (spec.requireAllRouted && route.unrouted.length)
    failures.push(`${route.unrouted.length} connection(s) remained open`);

  for (const rule of spec.forbidIntroducedRules ?? []) {
    const count = introducedErrors[rule] ?? 0;
    if (!count) continue;
    const message = `routing introduced ${count} ${rule} error(s)`;
    if (spec.quality === "gate") failures.push(message);
    else observations.push(message);
  }

  if (spec.quality === "observe" && route.unrouted.length)
    observations.push(`${route.unrouted.length} connection(s) remained open`);
  return { failures, observations, introducedErrors };
}

export function casesForTier(manifest: RegressionManifest, tier: RegressionTier): RegressionCase[] {
  if (manifest.schema !== 1)
    throw new Error(`unsupported regression manifest schema ${manifest.schema}`);
  const ids = new Set<string>();
  for (const c of manifest.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate regression case id ${c.id}`);
    ids.add(c.id);
    if (c.hardTimeoutMs <= c.routeTimeoutMs)
      throw new Error(`${c.id}: hardTimeoutMs must exceed routeTimeoutMs`);
  }
  return manifest.cases.filter((c) => tier === "nightly" || c.tier === "pr");
}
