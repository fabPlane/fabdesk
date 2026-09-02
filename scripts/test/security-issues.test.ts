import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintOf,
  formatSyncReport,
  planIssueSync,
  planFingerprintDuplicates,
  applyIssueSync,
  loadFiledLedger,
  writeFiledLedger,
  type GitHubIssues,
  type IssueRecord,
} from "../security-issues";
import { FINGERPRINT_COMMENT, type Finding } from "../security-scan";

const finding = (over: Partial<Finding> = {}): Finding => ({
  fingerprint: "aaaabbbbccccdddd",
  rule: "dep.advisory",
  severity: "high",
  title: "hono: JWT confusion",
  detail: "hono (<4.11.4)",
  ...over,
});

describe("planIssueSync", () => {
  test("creates a new high finding", () => {
    const plan = planIssueSync([finding()], [], "high");
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]?.kind).toBe("create");
  });

  test("skips an already-open fingerprint", () => {
    const existing: IssueRecord[] = [
      {
        number: 12,
        title: "[security] high: hono: JWT confusion",
        body: `${FINGERPRINT_COMMENT("aaaabbbbccccdddd")}\n`,
        state: "open",
      },
    ];
    const plan = planIssueSync([finding()], existing, "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]).toMatchObject({ kind: "skip-open", issue: { number: 12 } });
  });

  test("does not reopen a closed fingerprint (dismissed)", () => {
    const existing: IssueRecord[] = [
      {
        number: 9,
        title: "[security] high: hono: JWT confusion",
        body: `${FINGERPRINT_COMMENT("aaaabbbbccccdddd")}\n`,
        state: "closed",
      },
    ];
    const plan = planIssueSync([finding()], existing, "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]?.kind).toBe("skip-closed");
  });

  test("does not file below min severity", () => {
    const plan = planIssueSync([finding({ severity: "medium" })], [], "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]?.kind).toBe("skip-severity");
  });

  test("unlabeled open issues still dedupe by fingerprint", () => {
    const existing: IssueRecord[] = [
      {
        number: 7,
        title: "[security] high: hono: JWT confusion",
        body: `${FINGERPRINT_COMMENT("aaaabbbbccccdddd")}\n`,
        state: "open",
      },
    ];
    const plan = planIssueSync([finding()], existing, "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]?.kind).toBe("skip-open");
  });

  test("title collision against an open issue counts as a duplicate", () => {
    const existing: IssueRecord[] = [
      {
        number: 4,
        title: "[security] high: hono: JWT confusion",
        body: "legacy issue without a fingerprint comment",
        state: "open",
      },
    ];
    const plan = planIssueSync([finding()], existing, "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]?.kind).toBe("skip-open");
  });

  test("fingerprintOf reads the HTML comment", () => {
    expect(
      fingerprintOf({ number: 1, title: "x", body: FINGERPRINT_COMMENT("abc"), state: "open" }),
    ).toBe("abc");
    expect(fingerprintOf({ number: 1, title: "x", body: "nope", state: "open" })).toBeNull();
  });
});

describe("loadFiledLedger", () => {
  test("turns ledger fingerprints into skip-open records", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabdesk-led-"));
    const path = join(dir, "filed.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        fingerprints: {
          aaaabbbbccccdddd: { number: 7, title: "[security] high: hono: JWT confusion" },
        },
      }),
    );
    const records = loadFiledLedger(path);
    const plan = planIssueSync([finding()], records, "high");
    expect(plan.create).toHaveLength(0);
    expect(plan.actions[0]?.kind).toBe("skip-open");
  });

  test("writeFiledLedger keeps prior fingerprints and records new ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabdesk-led-w-"));
    const path = join(dir, "filed.json");
    const previous = {
      schema: 1 as const,
      note: "keep me",
      fingerprints: {
        aaaabbbbccccdddd: { number: 7, title: "old", url: "https://example.com/7" },
      },
    };
    const next = writeFiledLedger(path, previous, [
      {
        fingerprint: "eeeeffff00001111",
        number: 21,
        title: "new",
        url: "https://example.com/21",
      },
      {
        fingerprint: "aaaabbbbccccdddd",
        number: 99,
        title: "should not overwrite",
        url: "https://example.com/99",
      },
    ]);
    expect(next.note).toBe("keep me");
    expect(next.fingerprints.aaaabbbbccccdddd?.number).toBe(7);
    expect(next.fingerprints.eeeeffff00001111?.number).toBe(21);
    const disk = JSON.parse(readFileSync(path, "utf8")) as typeof next;
    expect(Object.keys(disk.fingerprints)).toHaveLength(2);
  });
});

describe("planFingerprintDuplicates", () => {
  test("keeps the lowest number and closes later copies", () => {
    const body = `${FINGERPRINT_COMMENT("aaaabbbbccccdddd")}\n`;
    const dupes = planFingerprintDuplicates([
      { number: 21, title: "copy", body, state: "open" },
      { number: 7, title: "orig", body, state: "open" },
      { number: 9, title: "other", body: `${FINGERPRINT_COMMENT("ffff")}\n`, state: "open" },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.keep.number).toBe(7);
    expect(dupes[0]?.close.number).toBe(21);
  });
});

describe("applyIssueSync", () => {
  test("creates only planned issues and is a no-op on dry-run", async () => {
    const created: string[] = [];
    const gh: GitHubIssues = {
      list: async () => [],
      create: async (issue) => {
        created.push(issue.title);
        return { number: created.length, url: `https://example.com/${created.length}` };
      },
      close: async () => {},
      ensureLabels: async () => {},
    };
    const plan = planIssueSync(
      [finding(), finding({ fingerprint: "eeeeffff00001111", title: "other" })],
      [],
      "high",
    );
    const dry = await applyIssueSync(plan, gh, { dryRun: true });
    expect(dry.created).toEqual([]);
    expect(created).toEqual([]);
    const live = await applyIssueSync(plan, gh);
    expect(live.created).toHaveLength(2);
    expect(created).toHaveLength(2);
    expect(formatSyncReport(plan, live.created)).toContain("create=2");
  });
});
