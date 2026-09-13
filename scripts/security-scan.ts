#!/usr/bin/env bun
/**
 * Daily security scan for Fabdesk-native source (apps/, packages/, scripts/, .github/).
 *
 *   bun run scripts/security-scan.ts
 *   bun run scripts/security-scan.ts --json --out findings.json
 *
 * Vendor trees, fixtures, and generated dirs are skipped. Dependency advisories come
 * from `bun audit --json`. High-confidence secret / dangerous-API hits come from a
 * conservative source walk. Findings carry a stable fingerprint used to dedupe GitHub issues.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface Finding {
  fingerprint: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  url?: string;
}

export const FINGERPRINT_COMMENT = (fp: string) => `<!-- fabdesk-security-fingerprint: ${fp} -->`;
export const FINGERPRINT_RE = /<!--\s*fabdesk-security-fingerprint:\s*([a-f0-9]+)\s*-->/i;

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".claude",
  "node_modules",
  "vendor",
  "dist",
  "out",
  "release",
  "coverage",
  ".cache",
  "__fixtures__",
]);

const SCAN_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".md",
  ".env",
  ".sh",
  ".bash",
  ".txt",
  ".html",
]);

const PLACEHOLDER_RE =
  /changeme|your[-_ ]?(?:token|key|secret|password)|xxx+|todo|placeholder|dummy|example|fake[-_]?secret|test[-_]?token|not-a-secret/i;

const SECRET_RULES: Array<{ rule: string; severity: Severity; title: string; re: RegExp }> = [
  {
    rule: "secret.private-key",
    severity: "critical",
    title: "Private key material committed",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    rule: "secret.github-pat",
    severity: "critical",
    title: "GitHub personal access token",
    re: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    rule: "secret.aws-access-key",
    severity: "critical",
    title: "AWS access key id",
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    rule: "secret.slack-token",
    severity: "critical",
    title: "Slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    rule: "secret.generic-credential",
    severity: "high",
    title: "Hard-coded credential assignment",
    // The lookbehind keeps `"?token="` / `"#token="` URL fragments in tests from
    // matching: their closing quote is not the start of a credential literal.
    re: /(?<![#?&.])\b(?:api[_-]?key|secret|password|token|access[_-]?key)\b\s*[:=]\s*['"][^'"]{20,}['"]/i,
  },
];

/** Dynamic code in a unit test is not a shipped attack surface; report it but never file it. */
const TEST_FILE_RE = /(?:^|[\\/])(?:__tests__[\\/]|[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/;

export function isTestFile(rel: string): boolean {
  return TEST_FILE_RE.test(rel);
}

const CODE_RULES: Array<{
  rule: string;
  severity: Severity;
  title: string;
  re: RegExp;
  ext?: Set<string>;
}> = [
  {
    rule: "code.eval",
    severity: "high",
    title: "Dynamic eval / Function constructor",
    re: /\b(?:eval|new\s+Function)\s*\(/,
    ext: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  },
  {
    rule: "code.document-write",
    severity: "medium",
    title: "document.write",
    re: /\bdocument\.write\s*\(/,
    ext: new Set([".ts", ".tsx", ".js", ".jsx"]),
  },
];

const SELF_FILES = new Set(["security-scan.ts", "security-issues.ts", "security-scan.test.ts"]);

export function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

export function parseSeverity(value: string | undefined): Severity | null {
  const v = value?.toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  if (v === "moderate") return "medium";
  return null;
}

export function atLeast(severity: Severity, min: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

export function ghsaFromUrl(url: string | undefined): string | undefined {
  const m = url ? /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url) : undefined;
  return m?.[0]?.toLowerCase();
}

function advisoryKey(pkg: string, adv: Record<string, unknown>): string | null {
  const url = typeof adv.url === "string" ? adv.url : undefined;
  const ghsa =
    ghsaFromUrl(url) ?? (typeof adv.ghsa === "string" ? adv.ghsa.toLowerCase() : undefined);
  const id = adv.id != null ? String(adv.id) : undefined;
  const title = typeof adv.title === "string" ? adv.title : undefined;
  const key = ghsa || id || title;
  return key ? `${pkg}\0${key}` : null;
}

function advisoryDetail(pkg: string, adv: Record<string, unknown>): string {
  const versions = typeof adv.vulnerable_versions === "string" ? adv.vulnerable_versions : "";
  const cwe =
    typeof adv.cwe === "string"
      ? adv.cwe
      : Array.isArray(adv.cwe)
        ? adv.cwe.map(String).join(", ")
        : "";
  return [`${pkg}${versions ? ` (${versions})` : ""}`, cwe ? `CWE: ${cwe}` : ""]
    .filter(Boolean)
    .join("\n");
}

/** bun audit --json is `{ [package]: Advisory[] }`. Same GHSA + package collapses to one finding. */
export function parseBunAudit(jsonText: string): Finding[] {
  const trimmed = jsonText.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("bun audit --json produced invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const byKey = new Map<string, Finding>();
  for (const [pkg, advisories] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(advisories)) continue;
    for (const raw of advisories) {
      if (!raw || typeof raw !== "object") continue;
      const adv = raw as Record<string, unknown>;
      const key = advisoryKey(pkg, adv);
      if (!key) continue;
      const title = String(adv.title ?? "dependency advisory");
      const severity = parseSeverity(String(adv.severity ?? "")) ?? "medium";
      const url = typeof adv.url === "string" ? adv.url : undefined;
      const ghsa = ghsaFromUrl(url);
      const existing = byKey.get(key);
      if (existing) {
        const extra = advisoryDetail(pkg, adv);
        if (extra && !existing.detail.includes(extra))
          existing.detail = `${existing.detail}\n${extra}`;
        if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity])
          existing.severity = severity;
        continue;
      }
      byKey.set(key, {
        fingerprint: fingerprint(["dep", key]),
        rule: "dep.advisory",
        severity,
        title: ghsa ? `${pkg} ${ghsa}: ${title}` : `${pkg}: ${title}`,
        detail: advisoryDetail(pkg, adv),
        ...(url ? { url } : {}),
      });
    }
  }
  return [...byKey.values()];
}

export async function runBunAudit(cwd: string): Promise<{ findings: Finding[]; error?: string }> {
  try {
    const proc = Bun.spawn(["bun", "audit", "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // bun audit exits non-zero when advisories exist; still parse stdout.
    if (!stdout.trim()) {
      if (exit !== 0) return { findings: [], error: stderr.trim() || `bun audit exited ${exit}` };
      return { findings: [] };
    }
    return { findings: parseBunAudit(stdout) };
  } catch (err) {
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function shouldScanPath(rel: string): boolean {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) return false;
  const base = parts[parts.length - 1] ?? "";
  if (SELF_FILES.has(base)) return false;
  if (base.endsWith(".jsonl")) return false;
  if (base === "bun.lock" || base === "package-lock.json") return false;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  if (base.startsWith(".env")) return true;
  return SCAN_EXT.has(ext);
}

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!st.isFile() || st.size > 1_000_000) continue;
      const rel = relative(root, full);
      if (!shouldScanPath(rel)) continue;
      out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

function lineNumber(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function snippet(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", index);
  return source
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 200);
}

export function scanFileContent(rel: string, source: string): Finding[] {
  if (source.includes("\0")) return [];
  const findings: Finding[] = [];
  const ext = rel.includes(".") ? `.${rel.split(".").pop()}` : "";
  const isExampleEnv = /(^|[\\/])\.env\.example$/.test(rel);

  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    const match = rule.re.exec(source);
    if (!match || match.index === undefined) continue;
    const text = match[0] ?? "";
    if (
      PLACEHOLDER_RE.test(text) ||
      (isExampleEnv && PLACEHOLDER_RE.test(snippet(source, match.index)))
    ) {
      continue;
    }
    const line = lineNumber(source, match.index);
    findings.push({
      fingerprint: fingerprint([rule.rule, rel, String(line), text.slice(0, 40)]),
      rule: rule.rule,
      severity: rule.severity,
      title: `${rule.title} in ${rel}`,
      detail: `${rel}:${line}: ${snippet(source, match.index)}`,
      file: rel,
      line,
    });
  }

  if (isExampleEnv) return findings;

  const inTest = isTestFile(rel);
  for (const rule of CODE_RULES) {
    if (rule.ext && !rule.ext.has(ext)) continue;
    rule.re.lastIndex = 0;
    const match = rule.re.exec(source);
    if (!match || match.index === undefined) continue;
    const line = lineNumber(source, match.index);
    findings.push({
      fingerprint: fingerprint([rule.rule, rel, String(line)]),
      rule: rule.rule,
      severity: inTest ? "low" : rule.severity,
      title: `${rule.title} in ${rel}`,
      detail: `${rel}:${line}: ${snippet(source, match.index)}`,
      file: rel,
      line,
    });
  }
  return findings;
}

export function scanSourceTree(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const full of walkFiles(root)) {
    let source: string;
    try {
      source = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanFileContent(relative(root, full).split(sep).join("/"), source));
  }
  return findings;
}

export async function scanRepo(root: string): Promise<{ findings: Finding[]; errors: string[] }> {
  const errors: string[] = [];
  const source = scanSourceTree(root);
  const audit = await runBunAudit(root);
  if (audit.error) errors.push(audit.error);
  const findings = [...audit.findings, ...source].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return sev !== 0 ? sev : a.fingerprint.localeCompare(b.fingerprint);
  });
  return { findings, errors };
}

export function formatIssueBody(finding: Finding): string {
  const lines = [
    FINGERPRINT_COMMENT(finding.fingerprint),
    "",
    `**Rule:** \`${finding.rule}\``,
    `**Severity:** ${finding.severity}`,
  ];
  if (finding.file)
    lines.push(`**File:** \`${finding.file}${finding.line ? `:${finding.line}` : ""}\``);
  if (finding.url) lines.push(`**Advisory:** ${finding.url}`);
  lines.push("", "## Detail", "", finding.detail, "", "---");
  lines.push(
    "Opened by the daily `security-scan` workflow. Deduplicated by the fingerprint HTML comment — do not remove it.",
  );
  return lines.join("\n");
}

export function issueTitle(finding: Finding): string {
  const prefix = `[security] ${finding.severity}: `;
  const rest = finding.title.replace(/\s+/g, " ").trim();
  const max = 240 - prefix.length;
  return prefix + (rest.length > max ? `${rest.slice(0, max - 1)}…` : rest);
}

export function formatReport(findings: Finding[], errors: string[]): string {
  const lines = [`# Security scan`, "", `${findings.length} finding(s).`];
  if (errors.length) {
    lines.push("", "## Errors", ...errors.map((e) => `- ${e}`));
  }
  for (const f of findings) {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    lines.push(`- **${f.severity}** \`${f.fingerprint}\` ${f.title}${loc}`);
  }
  return `${lines.join("\n")}\n`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

if (import.meta.main) {
  const root = arg("root") ?? dirname(import.meta.dir);
  const { findings, errors } = await scanRepo(root);
  const json = process.argv.includes("--json");
  const out = arg("out");
  const payload = { findings, errors };
  const text = json ? `${JSON.stringify(payload, null, 2)}\n` : formatReport(findings, errors);
  if (out) writeFileSync(out, json ? JSON.stringify(payload, null, 2) + "\n" : text);
  else process.stdout.write(text);
  if (errors.length) console.error(errors.join("\n"));
}
