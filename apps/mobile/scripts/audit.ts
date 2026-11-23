import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyInstallation } = require("./picomatch-guard.cjs") as {
  verifyInstallation(root: string): number;
};
const advisoryUrl = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

type Advisory = { id: number; url: string; title: string; vulnerable_versions: string; severity: string };
export function remainingFindings(report: unknown): Record<string, Advisory[]> {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Invalid audit report");
  const remaining: Record<string, Advisory[]> = {};
  for (const [name, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) throw new Error("Invalid advisory list");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.url !== "string") throw new Error("Invalid advisory");
      // Only this exact report is covered by the separately hash-verified local patches.
      // New advisories and changed affected ranges remain errors, even on picomatch.
      if (name === "picomatch" && entry.id === 1247710 && entry.url === advisoryUrl &&
          entry.vulnerable_versions === "<=4.0.7" && entry.severity === "high" &&
          entry.title === "picomatch vulnerable to ReDoS through single-branch repeated extglobs") continue;
      (remaining[name] ??= []).push(entry);
    }
  }
  return remaining;
}

export function assessAudit(report: unknown, exitCode: number, verify: () => number) {
  const count = verify(); // Always fails closed if even one installed copy is unpatched.
  const remaining = remainingFindings(report);
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`Audit command failed (${exitCode})`);
  if (exitCode !== 0 && Object.keys(report as object).length === 0) throw new Error("Audit failed without findings");
  if (Object.keys(remaining).length) throw new Error(`Unmitigated dependency advisories:\n${JSON.stringify(remaining, null, 2)}`);
  return count;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const proc = Bun.spawnSync(["bun", "audit", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.signalCode) throw new Error(`Audit terminated: ${proc.signalCode}`);
  let report: unknown;
  try { report = JSON.parse(proc.stdout.toString()); }
  catch { throw new Error(`Audit did not return JSON: ${proc.stderr.toString()}`); }
  const count = assessAudit(report, proc.exitCode, () => verifyInstallation(root));
  console.log(`Audit passed: ${count} installed picomatch copies verified against local patches and Node regression tests; no unmitigated advisories.`);
}
