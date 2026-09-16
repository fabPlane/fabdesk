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

type ErrorInstances = { signatures: Map<string, number>; unsigned: number };

function errorInstances(report: DrcReport): Map<string, ErrorInstances> {
  const byRule = new Map<string, ErrorInstances>();
  for (const violation of [...report.violations, ...report.schematicParity]) {
    if (violation.severity !== "error") continue;
    const instances = byRule.get(violation.rule) ?? { signatures: new Map(), unsigned: 0 };
    if (violation.signature)
      instances.signatures.set(
        violation.signature,
        (instances.signatures.get(violation.signature) ?? 0) + 1,
      );
    else instances.unsigned++;
    byRule.set(violation.rule, instances);
  }
  return byRule;
}

/** DRC errors added by routing, matched by signature when KiCad supplies one and by count otherwise. */
export function introducedDrcErrors(before: DrcReport, after: DrcReport): Record<string, number> {
  const pre = errorInstances(before);
  const post = errorInstances(after);
  const out: Record<string, number> = {};
  for (const [rule, instances] of post) {
    const previous = pre.get(rule) ?? { signatures: new Map(), unsigned: 0 };
    let added = Math.max(0, instances.unsigned - previous.unsigned);
    for (const [signature, count] of instances.signatures)
      added += Math.max(0, count - (previous.signatures.get(signature) ?? 0));
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
  const qualityFinding = (message: string) =>
    (spec.quality === "gate" ? failures : observations).push(message);
  if (spec.requireAllRouted && after.counts.unconnected)
    qualityFinding(`KiCad DRC reports ${after.counts.unconnected} unconnected item(s)`);
  if (spec.requireAllRouted && route.unrouted.length)
    qualityFinding(`router reports ${route.unrouted.length} connection(s) remained open`);

  for (const rule of spec.forbidIntroducedRules ?? []) {
    const count = introducedErrors[rule] ?? 0;
    if (!count) continue;
    const message = `routing introduced ${count} ${rule} error(s)`;
    if (spec.quality === "gate") failures.push(message);
    else observations.push(message);
  }

  if (spec.quality === "observe" && !spec.requireAllRouted && route.unrouted.length)
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
