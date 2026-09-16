import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FINGERPRINT_COMMENT,
  FINGERPRINT_RE,
  atLeast,
  fingerprint,
  formatIssueBody,
  issueTitle,
  parseBunAudit,
  parseSeverity,
  scanFileContent,
  scanSourceTree,
  isTestFile,
  shouldScanPath,
} from "../security-scan";

describe("fingerprint + severity", () => {
  test("fingerprint is stable and short", () => {
    expect(fingerprint(["dep", "hono", "1112134"])).toBe(fingerprint(["dep", "hono", "1112134"]));
    expect(fingerprint(["dep", "hono", "1112134"])).not.toBe(fingerprint(["dep", "hono", "other"]));
    expect(fingerprint(["a"])).toHaveLength(16);
  });

  test("parseSeverity maps moderate", () => {
    expect(parseSeverity("CRITICAL")).toBe("critical");
    expect(parseSeverity("moderate")).toBe("medium");
    expect(parseSeverity("nope")).toBeNull();
    expect(atLeast("high", "high")).toBe(true);
    expect(atLeast("medium", "high")).toBe(false);
  });
});

describe("parseBunAudit", () => {
  test("reads bun audit --json package→advisory map", () => {
    const findings = parseBunAudit(
      JSON.stringify({
        hono: [
          {
            id: 1112134,
            url: "https://github.com/advisories/GHSA-3vhc-576x-3qv4",
            title: "JWT algorithm confusion",
            severity: "high",
            vulnerable_versions: "<4.11.4",
            cwe: ["CWE-347"],
          },
        ],
        "fast-xml-parser": [
          {
            id: 1113568,
            url: "https://github.com/advisories/GHSA-m7jm-9gc2-mpf2",
            title: "entity encoding bypass",
            severity: "critical",
            vulnerable_versions: ">=5.0.0 <5.3.5",
          },
        ],
      }),
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.rule).toBe("dep.advisory");
    expect(findings.find((f) => f.title.includes("hono"))?.severity).toBe("high");
    expect(findings.find((f) => f.title.includes("fast-xml-parser"))?.severity).toBe("critical");
    expect(findings.find((f) => f.title.includes("ghsa-3vhc-576x-3qv4"))).toBeTruthy();
    expect(findings[0]?.fingerprint).toHaveLength(16);
  });

  test("collapses the same GHSA listed for two version ranges", () => {
    const findings = parseBunAudit(
      JSON.stringify({
        nanoid: [
          {
            id: 1,
            url: "https://github.com/advisories/GHSA-xwg4-73v4-xw9w",
            title: "Integer Overflow",
            severity: "high",
            vulnerable_versions: "<3.3.12",
          },
          {
            id: 2,
            url: "https://github.com/advisories/GHSA-xwg4-73v4-xw9w",
            title: "Integer Overflow",
            severity: "high",
            vulnerable_versions: ">=4.0.0 <5.1.11",
          },
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("<3.3.12");
    expect(findings[0]?.detail).toContain(">=4.0.0 <5.1.11");
    expect(findings[0]?.title).toContain("ghsa-xwg4-73v4-xw9w");
  });

  test("empty and non-object JSON yield no findings", () => {
    expect(parseBunAudit("")).toEqual([]);
    expect(parseBunAudit("[]")).toEqual([]);
    expect(() => parseBunAudit("not-json")).toThrow();
  });
});

describe("source walk", () => {
  test("skips vendor, fixtures, lockfiles, and the scanner itself", () => {
    expect(shouldScanPath("apps/core/src/auth.ts")).toBe(true);
    expect(shouldScanPath("vendor/fabplane/packages/auth/src/x.ts")).toBe(false);
    expect(shouldScanPath("packages/agents/src/__fixtures__/grok-hello.jsonl")).toBe(false);
    expect(shouldScanPath("scripts/security-scan.ts")).toBe(false);
    expect(shouldScanPath("bun.lock")).toBe(false);
    expect(shouldScanPath(".env.example")).toBe(true);
    expect(shouldScanPath(".claude/worktrees/agent-1/apps/core/src/auth.ts")).toBe(false);
  });

  test("dynamic code in a test file is reported at low severity", () => {
    const src = 'const run = new Function("document", script);\n';
    const [test] = scanFileContent("packages/ui/src/theme/resolve.test.ts", src);
    const [prod] = scanFileContent("packages/ui/src/theme/resolve.ts", src);
    expect(test?.rule).toBe("code.eval");
    expect(test?.severity).toBe("low");
    expect(prod?.severity).toBe("high");
    expect(isTestFile("apps/desktop/src/__tests__/bridge.ts")).toBe(true);
    expect(isTestFile("apps/desktop/src/main/automation-server.spec.tsx")).toBe(true);
    expect(isTestFile("apps/desktop/src/main/automation-server.ts")).toBe(false);
  });

  test("a URL fragment key is not a credential assignment", () => {
    const line =
      'expect(https("?host=https://mac.tailnet.ts.net", "#token=")).toEqual({ host: "x" });';
    expect(scanFileContent("packages/ui/src/pair/parse.test.ts", line)).toEqual([]);
    const real = `const token = "${"k".repeat(32)}";`;
    expect(scanFileContent("apps/core/src/x.ts", real).map((f) => f.rule)).toEqual([
      "secret.generic-credential",
    ]);
  });

  test("flags a real-looking GitHub token and PEM, ignores placeholders", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    const hits = [
      ...scanFileContent("apps/core/src/leak.ts", `const t = "${token}";`),
      ...scanFileContent("apps/core/src/key.pem.ts", pem),
      ...scanFileContent(".env.example", 'FABDESK_TOKEN="your-token-here-please-replace"'),
      ...scanFileContent("apps/core/src/ok.ts", 'const password = "changeme-not-real";'),
    ];
    expect(hits.some((h) => h.rule === "secret.github-pat")).toBe(true);
    expect(hits.some((h) => h.rule === "secret.private-key")).toBe(true);
    expect(hits.some((h) => h.file === ".env.example")).toBe(false);
  });

  test("scanSourceTree walks a planted tree and skips vendor", () => {
    const root = join(tmpdir(), `fabdesk-sec-${Date.now()}`);
    mkdirSync(join(root, "apps", "core"), { recursive: true });
    mkdirSync(join(root, "vendor", "fabplane"), { recursive: true });
    writeFileSync(
      join(root, "apps", "core", "leak.ts"),
      `export const k = "AKIA${"B".repeat(16)}";\n`,
    );
    writeFileSync(
      join(root, "vendor", "fabplane", "leak.ts"),
      `export const k = "AKIA${"C".repeat(16)}";\n`,
    );
    const findings = scanSourceTree(root);
    expect(findings.some((f) => f.file === "apps/core/leak.ts")).toBe(true);
    expect(findings.some((f) => f.file?.includes("vendor"))).toBe(false);
  });
});

describe("issue formatting", () => {
  test("embeds a parseable fingerprint comment", () => {
    const finding = {
      fingerprint: "deadbeefcafebabe",
      rule: "dep.advisory",
      severity: "high" as const,
      title: "hono: JWT confusion",
      detail: "hono (<4.11.4)",
      url: "https://example.com/ghsa",
    };
    const body = formatIssueBody(finding);
    expect(body).toContain(FINGERPRINT_COMMENT("deadbeefcafebabe"));
    expect(FINGERPRINT_RE.exec(body)?.[1]).toBe("deadbeefcafebabe");
    expect(issueTitle(finding).startsWith("[security] high: ")).toBe(true);
  });
});
