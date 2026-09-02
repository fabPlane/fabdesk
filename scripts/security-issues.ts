#!/usr/bin/env bun
/**
 * Sync security-scan findings to GitHub issues with fingerprint dedup.
 *
 *   bun run scripts/security-issues.ts --findings findings.json
 *   bun run scripts/security-issues.ts --findings findings.json --dry-run
 *
 * Open issues whose body contains `<!-- fabdesk-security-fingerprint: … -->` are reused.
 * Closed issues with the same fingerprint are left closed (treated as dismissed).
 * Only findings at or above `--min-severity` (default: high) become issues.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  atLeast,
  FINGERPRINT_COMMENT,
  FINGERPRINT_RE,
  formatIssueBody,
  issueTitle,
  parseSeverity,
  type Finding,
  type Severity,
} from "./security-scan";

export const DEFAULT_LEDGER = ".github/security-filed.json";

export interface FiledLedger {
  schema: 1;
  note?: string;
  fingerprints: Record<string, { number: number; title: string; url?: string }>;
}

export const SECURITY_LABEL = "security-scan";
export const SECURITY_LABELS = ["security", SECURITY_LABEL] as const;

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url?: string;
}

export interface IssueCreate {
  title: string;
  body: string;
  labels: string[];
}

export interface GitHubIssues {
  list(state: "open" | "closed"): Promise<IssueRecord[]>;
  create(issue: IssueCreate): Promise<{ number: number; url: string }>;
  close(number: number, comment: string): Promise<void>;
  ensureLabels(names: readonly string[]): Promise<void>;
}

export type SyncAction =
  | { kind: "create"; finding: Finding; title: string; body: string }
  | { kind: "skip-open"; finding: Finding; issue: IssueRecord }
  | { kind: "skip-closed"; finding: Finding; issue: IssueRecord }
  | { kind: "skip-severity"; finding: Finding };

export interface SyncPlan {
  actions: SyncAction[];
  create: SyncAction[];
}

/** Keep the lowest issue number; extras with the same fingerprint should be closed. */
export function planFingerprintDuplicates(
  existing: IssueRecord[],
): Array<{ keep: IssueRecord; close: IssueRecord; fingerprint: string }> {
  const byFp = new Map<string, IssueRecord[]>();
  for (const issue of existing) {
    if (issue.state !== "open") continue;
    const fp = fingerprintOf(issue);
    if (!fp) continue;
    const list = byFp.get(fp) ?? [];
    list.push(issue);
    byFp.set(fp, list);
  }
  const out: Array<{ keep: IssueRecord; close: IssueRecord; fingerprint: string }> = [];
  for (const [fingerprint, issues] of byFp) {
    if (issues.length < 2) continue;
    const sorted = [...issues].sort((a, b) => a.number - b.number);
    const keep = sorted[0];
    if (!keep) continue;
    for (const extra of sorted.slice(1)) out.push({ keep, close: extra, fingerprint });
  }
  return out;
}

export function fingerprintOf(issue: IssueRecord): string | null {
  const m = FINGERPRINT_RE.exec(issue.body ?? "");
  return m?.[1] ?? null;
}

export function planIssueSync(
  findings: Finding[],
  existing: IssueRecord[],
  min: Severity,
): SyncPlan {
  const byFp = new Map<string, IssueRecord>();
  const openTitles = new Set<string>();
  for (const issue of existing) {
    const fp = fingerprintOf(issue);
    if (fp) {
      const prev = byFp.get(fp);
      if (!prev || issue.number < prev.number) byFp.set(fp, issue);
    }
    if (issue.state === "open") openTitles.add(issue.title);
  }

  const actions: SyncAction[] = [];
  for (const finding of findings) {
    if (!atLeast(finding.severity, min)) {
      actions.push({ kind: "skip-severity", finding });
      continue;
    }
    const hit = byFp.get(finding.fingerprint);
    if (hit?.state === "open") {
      actions.push({ kind: "skip-open", finding, issue: hit });
      continue;
    }
    if (hit?.state === "closed") {
      actions.push({ kind: "skip-closed", finding, issue: hit });
      continue;
    }
    const title = issueTitle(finding);
    if (openTitles.has(title)) {
      const issue = existing.find((i) => i.state === "open" && i.title === title);
      if (issue) {
        actions.push({ kind: "skip-open", finding, issue });
        continue;
      }
    }
    actions.push({ kind: "create", finding, title, body: formatIssueBody(finding) });
    openTitles.add(title);
  }
  return { actions, create: actions.filter((a) => a.kind === "create") };
}

export async function applyIssueSync(
  plan: SyncPlan,
  gh: GitHubIssues,
  opts: { dryRun?: boolean } = {},
): Promise<{ created: Array<{ number: number; url: string; title: string }>; dryRun: boolean }> {
  if (opts.dryRun) return { created: [], dryRun: true };
  if (plan.create.length === 0) return { created: [], dryRun: false };
  await gh.ensureLabels(SECURITY_LABELS);
  const created: Array<{ number: number; url: string; title: string }> = [];
  for (const action of plan.create) {
    if (action.kind !== "create") continue;
    const issue = await gh.create({
      title: action.title,
      body: action.body,
      labels: [...SECURITY_LABELS],
    });
    created.push({ number: issue.number, url: issue.url, title: action.title });
  }
  return { created, dryRun: false };
}

export function loadFiledLedger(path: string): IssueRecord[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const fps =
    parsed && typeof parsed === "object" && parsed !== null && "fingerprints" in parsed
      ? (parsed as FiledLedger).fingerprints
      : null;
  if (!fps || typeof fps !== "object") return [];
  const out: IssueRecord[] = [];
  for (const [fp, meta] of Object.entries(fps)) {
    if (!meta || typeof meta !== "object") continue;
    out.push({
      number: Number(meta.number),
      title: String(meta.title ?? ""),
      body: FINGERPRINT_COMMENT(fp),
      state: "open",
      ...(meta.url ? { url: meta.url } : {}),
    });
  }
  return out;
}

export function writeFiledLedger(
  path: string,
  existing: FiledLedger | undefined,
  created: Array<{ fingerprint: string; number: number; title: string; url: string }>,
): FiledLedger {
  const fingerprints = { ...(existing?.fingerprints ?? {}) };
  for (const c of created) {
    if (!fingerprints[c.fingerprint]) {
      fingerprints[c.fingerprint] = {
        number: c.number,
        title: c.title,
        ...(c.url ? { url: c.url } : {}),
      };
    }
  }
  const ledger: FiledLedger = {
    schema: 1,
    ...(existing?.note ? { note: existing.note } : {}),
    fingerprints,
  };
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

export function loadFindings(path: string): Finding[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : null;
  if (!list) throw new Error(`${path} must be a findings array or { findings: [...] }`);
  return list.filter(
    (f): f is Finding =>
      !!f && typeof f === "object" && typeof (f as Finding).fingerprint === "string",
  );
}

export function formatSyncReport(
  plan: SyncPlan,
  created: Array<{ number: number; url: string; title: string }>,
): string {
  const counts = { create: 0, "skip-open": 0, "skip-closed": 0, "skip-severity": 0 };
  for (const a of plan.actions) counts[a.kind]++;
  const lines = [
    `# Issue sync`,
    "",
    `create=${counts.create} skip-open=${counts["skip-open"]} skip-closed=${counts["skip-closed"]} skip-severity=${counts["skip-severity"]}`,
  ];
  for (const c of created) lines.push(`- opened #${c.number} ${c.url} — ${c.title}`);
  for (const a of plan.create) {
    if (a.kind === "create" && !created.some((c) => c.title === a.title)) {
      lines.push(`- would open: ${a.title} (\`${a.finding.fingerprint}\`)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

export function ghCliIssues(): GitHubIssues {
  return {
    async list(state) {
      // Do not filter by label. The first filing created issues whose labels
      // did not stick, and `--label security-scan` then returned empty — so the
      // next run opened a second copy of every finding.
      const raw = await runGh([
        "issue",
        "list",
        "--state",
        state,
        "--limit",
        "200",
        "--json",
        "number,title,body,state,url",
      ]);
      const parsed: unknown = JSON.parse(raw || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed as IssueRecord[];
    },
    async create(issue) {
      const args = ["issue", "create", "--title", issue.title, "--body", issue.body];
      for (const label of issue.labels) args.push("--label", label);
      try {
        const url = (await runGh(args)).trim();
        const m = /\/issues\/(\d+)/.exec(url);
        return { number: m?.[1] ? Number(m[1]) : 0, url };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/label/i.test(msg)) throw err;
        const url = (
          await runGh(["issue", "create", "--title", issue.title, "--body", issue.body])
        ).trim();
        const m = /\/issues\/(\d+)/.exec(url);
        return { number: m?.[1] ? Number(m[1]) : 0, url };
      }
    },
    async close(number, comment) {
      await runGh([
        "issue",
        "close",
        String(number),
        "--reason",
        "not planned",
        "--comment",
        comment,
      ]);
    },
    async ensureLabels(names) {
      for (const name of names) {
        try {
          await runGh([
            "label",
            "create",
            name,
            "--color",
            name === SECURITY_LABEL ? "B60205" : "D93F0B",
            "--description",
            name === SECURITY_LABEL
              ? "Opened by the daily security-scan workflow"
              : "Security finding",
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(msg)) {
            console.error(`warning: could not ensure label ${name}: ${msg}`);
          }
        }
      }
    },
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

if (import.meta.main) {
  const findingsPath = arg("findings");
  if (!findingsPath) {
    console.error("missing --findings <path>");
    process.exit(2);
  }
  const min = parseSeverity(arg("min-severity") ?? "high") ?? "high";
  const dryRun = process.argv.includes("--dry-run");
  const findings = loadFindings(findingsPath);
  const ledgerPath = arg("ledger") ?? DEFAULT_LEDGER;
  const ledgerRecords = loadFiledLedger(ledgerPath);
  const gh = ghCliIssues();
  let existing: IssueRecord[] = [...ledgerRecords];
  try {
    existing = [...ledgerRecords, ...(await gh.list("open")), ...(await gh.list("closed"))];
  } catch (err) {
    console.error(
      `warning: could not list issues (${err instanceof Error ? err.message : err}); using ledger only (${ledgerRecords.length})`,
    );
    if (!dryRun && ledgerRecords.length === 0) throw err;
  }
  const closeDupes = process.argv.includes("--close-duplicates");
  if (closeDupes) {
    const dupes = planFingerprintDuplicates(existing);
    for (const d of dupes) {
      const comment = `Duplicate of #${d.keep.number} (fingerprint \`${d.fingerprint}\`). Closed by security-issues.ts.`;
      await gh.close(d.close.number, comment);
      process.stdout.write(`closed #${d.close.number} as duplicate of #${d.keep.number}\n`);
    }
    if (dupes.length === 0) process.stdout.write("no fingerprint duplicates to close\n");
  }
  const plan = planIssueSync(findings, existing, min);
  const { created } = await applyIssueSync(plan, gh, { ...(dryRun ? { dryRun: true } : {}) });
  if (created.length > 0) {
    let previous: FiledLedger | undefined;
    if (existsSync(ledgerPath)) {
      previous = JSON.parse(readFileSync(ledgerPath, "utf8")) as FiledLedger;
    }
    const updates = created.flatMap((c) => {
      const action = plan.create.find((a) => a.kind === "create" && a.title === c.title);
      return action && action.kind === "create"
        ? [
            {
              fingerprint: action.finding.fingerprint,
              number: c.number,
              title: c.title,
              url: c.url,
            },
          ]
        : [];
    });
    writeFiledLedger(ledgerPath, previous, updates);
  }
  process.stdout.write(formatSyncReport(plan, created));
}
