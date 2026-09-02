#!/usr/bin/env bun
/**
 * Collect open-PR metadata and classify whether each PR still looks relevant.
 *
 *   bun run scripts/pr-relevance.ts
 *   bun run scripts/pr-relevance.ts --json
 *
 * The daily Grok job uses this as the structured input, then reads diffs and
 * notifies in the Grok Cloud Agent conversation when a PR is still relevant.
 */
export type PrRelevance = "active" | "needs-attention" | "stale" | "draft-idle" | "abandoned";

export interface OpenPr {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus?: string;
  additions: number;
  deletions: number;
  headRef: string;
  baseRef: string;
}

export interface ClassifiedPr extends OpenPr {
  relevance: PrRelevance;
  notify: boolean;
  reasons: string[];
  daysOpen: number;
  daysSinceUpdate: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

export function classifyPr(pr: OpenPr, now: Date = new Date()): ClassifiedPr {
  const daysOpen = daysBetween(pr.createdAt, now);
  const daysSinceUpdate = daysBetween(pr.updatedAt, now);
  const reasons: string[] = [];
  const merge = `${pr.mergeable} ${pr.mergeStateStatus ?? ""}`.toUpperCase();
  const conflicted = /\b(CONFLICTING|DIRTY)\b/.test(merge);
  const behind = /\bBEHIND\b/.test(merge);
  const blocked = /\bBLOCKED\b/.test(merge);

  if (pr.draft) reasons.push("draft");
  if (conflicted) reasons.push("merge conflicts");
  if (behind) reasons.push("behind base");
  if (blocked) reasons.push("blocked");
  if (daysSinceUpdate === 0) reasons.push("updated today");
  else if (daysSinceUpdate <= 2) reasons.push(`updated ${daysSinceUpdate}d ago`);
  else reasons.push(`quiet for ${daysSinceUpdate}d`);

  let relevance: PrRelevance;
  if (pr.draft && daysSinceUpdate >= 7) relevance = "draft-idle";
  else if (!pr.draft && daysSinceUpdate >= 21) relevance = "abandoned";
  else if (daysSinceUpdate >= 7 || conflicted || behind || blocked) relevance = "needs-attention";
  else if (daysSinceUpdate >= 3) relevance = "stale";
  else relevance = "active";

  // Notify on anything that still looks like live work. Idle drafts and
  // long-abandoned PRs are listed in the digest but do not page the owner.
  const notify = relevance === "active" || relevance === "needs-attention" || relevance === "stale";

  return {
    ...pr,
    relevance,
    notify,
    reasons,
    daysOpen,
    daysSinceUpdate,
  };
}

export function formatPrDigest(prs: ClassifiedPr[]): string {
  const notify = prs.filter((p) => p.notify);
  const quiet = prs.filter((p) => !p.notify);
  const lines = [
    `# Open PR relevance`,
    "",
    `${prs.length} open, ${notify.length} still relevant (notify), ${quiet.length} idle.`,
    "",
  ];
  if (notify.length) {
    lines.push(`## Notify`);
    for (const p of notify) {
      lines.push(
        `- **#${p.number}** ${p.title} — ${p.relevance} (${p.reasons.join("; ")}) ${p.url}`,
      );
    }
    lines.push("");
  }
  if (quiet.length) {
    lines.push(`## Idle (no page)`);
    for (const p of quiet) {
      lines.push(`- #${p.number} ${p.title} — ${p.relevance} (${p.reasons.join("; ")})`);
    }
    lines.push("");
  }
  if (prs.length === 0) lines.push("No open pull requests.");
  return `${lines.join("\n")}\n`;
}

export function parsePrList(jsonText: string): OpenPr[] {
  const parsed: unknown = JSON.parse(jsonText || "[]");
  if (!Array.isArray(parsed)) return [];
  const out: OpenPr[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const author =
      typeof p.author === "string"
        ? p.author
        : p.author &&
            typeof p.author === "object" &&
            typeof (p.author as { login?: unknown }).login === "string"
          ? (p.author as { login: string }).login
          : "unknown";
    const number = Number(p.number);
    if (!Number.isFinite(number)) continue;
    out.push({
      number,
      title: String(p.title ?? ""),
      url: String(p.url ?? ""),
      author,
      draft: Boolean(p.isDraft ?? p.draft),
      createdAt: String(p.createdAt ?? ""),
      updatedAt: String(p.updatedAt ?? ""),
      mergeable: String(p.mergeable ?? ""),
      ...(typeof p.mergeStateStatus === "string" ? { mergeStateStatus: p.mergeStateStatus } : {}),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      headRef: String(p.headRefName ?? p.headRef ?? ""),
      baseRef: String(p.baseRefName ?? p.baseRef ?? "main"),
    });
  }
  return out;
}

export async function listOpenPrs(): Promise<OpenPr[]> {
  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,url,author,isDraft,createdAt,updatedAt,mergeable,mergeStateStatus,additions,deletions,headRefName,baseRefName",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`gh pr list failed: ${stderr.trim() || stdout.trim()}`);
  return parsePrList(stdout);
}

if (import.meta.main) {
  const prs = (await listOpenPrs()).map((p) => classifyPr(p));
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ prs }, null, 2)}\n`);
  } else {
    process.stdout.write(formatPrDigest(prs));
  }
}
