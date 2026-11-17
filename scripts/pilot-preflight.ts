/** Compare captured effective inputs before starting a scored pair. Never starts the timer. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod/v4";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const Capture = z.object({
  capturedAt: z.string().datetime(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  commonFixCommits: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1),
  backend: z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  model: z.string().min(1), effort: z.string().min(1), timeLimitSeconds: z.number().int().positive(),
  window: z.object({ width: z.number().positive(), height: z.number().positive(), zoom: z.number().positive(), scale: z.number().positive() }).strict(),
  // Full actual launch inputs, rather than names of requested inputs or hashes alone.
  effective: z.record(z.string(), z.string()),
  readiness: z.object({ baseline: z.boolean(), freshInstall: z.boolean(), compileOverride: z.boolean(), stalePcbGate: z.boolean(), relocatedDesktopReopen: z.boolean() }).strict(),
}).strict();
const Difference = z.object({ key: z.string(), main: z.string(), pr: z.string(), reason: z.string().min(1) }).strict();
export const PilotPair = z.object({
  contract: z.literal("fabdesk.pilot-preflight.v1"), order: z.literal("pr-first"),
  main: Capture, pr: Capture,
  // Exact full-value substitutions only. No regexes, deleted fields or wildcard exemptions.
  allowedDifferences: z.array(Difference),
  frozen: z.object({ briefSha256: z.string().regex(/^[a-f0-9]{64}$/), graderSha256: z.string().regex(/^[a-f0-9]{64}$/), fixturesSha256: z.string().regex(/^[a-f0-9]{64}$/), plotOptions: z.record(z.string(), z.string()) }).strict(),
}).strict();
const requiredInputs = ["instructions", "skillCatalog", "plugins", "mcpEndpoints", "settings"];
export function preflight(input: unknown) {
  const pair = PilotPair.parse(input), failures: string[] = [];
  for (const arm of ["main", "pr"] as const) {
    for (const key of requiredInputs) if (!pair[arm].effective[key]?.trim()) failures.push(`${arm}: missing captured ${key}`);
    for (const [key, passed] of Object.entries(pair[arm].readiness)) if (!passed) failures.push(`${arm}: readiness ${key} incomplete`);
  }
  for (const key of ["commonFixCommits", "backend", "model", "effort", "timeLimitSeconds", "window"] as const)
    if (stable(pair.main[key]) !== stable(pair.pr[key])) failures.push(`mismatched ${key}`);
  const normalized = { main: { ...pair.main.effective }, pr: { ...pair.pr.effective } };
  const seen = new Set<string>();
  for (const difference of pair.allowedDifferences) {
    if (seen.has(difference.key)) failures.push(`duplicate exemption ${difference.key}`);
    seen.add(difference.key);
    if (difference.main === difference.pr || pair.main.effective[difference.key] !== difference.main || pair.pr.effective[difference.key] !== difference.pr) {
      failures.push(`unused or mismatched exemption ${difference.key}`); continue;
    }
    // Preserve shared instruction/catalog bytes: only explicit checkout/tool fields may differ.
    if (!["checkoutPath", "productTools"].includes(difference.key)) { failures.push(`forbidden exemption ${difference.key}`); continue; }
    normalized.main[difference.key] = normalized.pr[difference.key] = `<allowed:${difference.key}>`;
  }
  for (const key of new Set([...Object.keys(normalized.main), ...Object.keys(normalized.pr)]))
    if (normalized.main[key] !== normalized.pr[key]) failures.push(`effective input mismatch ${key}`);
  return { contract: pair.contract, ready: failures.length === 0, failures, inputSha256: sha(stable(pair)), fullHashes: { main: sha(stable(pair.main)), pr: sha(stable(pair.pr)) }, normalizedHashes: { main: sha(stable(normalized.main)), pr: sha(stable(normalized.pr)) }, allowedDifferences: pair.allowedDifferences };
}
if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error("usage: bun scripts/pilot-preflight.ts capture.json NEW-report.json");
  const report = preflight(JSON.parse(await readFile(input, "utf8")));
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report));
  if (!report.ready) process.exitCode = 1;
}
