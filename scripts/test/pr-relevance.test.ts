import { describe, expect, test } from "bun:test";
import { classifyPr, daysBetween, formatPrDigest, parsePrList, type OpenPr } from "../pr-relevance";

const now = new Date("2026-09-02T12:00:00Z");

const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  number: 2,
  title: "fix bun PATH",
  url: "https://github.com/TensorFleet/fabdesk/pull/2",
  author: "mattkanwisher",
  draft: false,
  createdAt: "2026-09-02T07:20:59Z",
  updatedAt: "2026-09-02T07:29:27Z",
  mergeable: "MERGEABLE",
  additions: 10,
  deletions: 4,
  headRef: "cursor/fix-bun-path-7fd7",
  baseRef: "main",
  ...over,
});

describe("classifyPr", () => {
  test("fresh mergeable PR is active and notifiable", () => {
    const c = classifyPr(pr(), now);
    expect(c.relevance).toBe("active");
    expect(c.notify).toBe(true);
    expect(c.daysSinceUpdate).toBe(0);
  });

  test("quiet for a few days is stale but still notified", () => {
    const c = classifyPr(pr({ updatedAt: "2026-08-29T12:00:00Z" }), now);
    expect(c.relevance).toBe("stale");
    expect(c.notify).toBe(true);
  });

  test("behind or conflicted needs attention", () => {
    const behind = classifyPr(
      pr({ mergeStateStatus: "BEHIND", updatedAt: "2026-08-20T12:00:00Z" }),
      now,
    );
    expect(behind.relevance).toBe("needs-attention");
    expect(behind.notify).toBe(true);
    const dirty = classifyPr(pr({ mergeable: "CONFLICTING" }), now);
    expect(dirty.reasons).toContain("merge conflicts");
  });

  test("idle drafts and long-abandoned PRs are not paged", () => {
    const draft = classifyPr(
      pr({ draft: true, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }),
      now,
    );
    expect(draft.relevance).toBe("draft-idle");
    expect(draft.notify).toBe(false);
    const dead = classifyPr(
      pr({ createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" }),
      now,
    );
    expect(dead.relevance).toBe("abandoned");
    expect(dead.notify).toBe(false);
  });
});

describe("parse + digest", () => {
  test("daysBetween floors to whole days", () => {
    expect(daysBetween("2026-09-01T12:00:00Z", now)).toBe(1);
    expect(daysBetween("not-a-date", now)).toBe(0);
  });

  test("parsePrList accepts gh pr list --json", () => {
    const prs = parsePrList(
      JSON.stringify([
        {
          number: 3,
          title: "password login",
          url: "https://github.com/TensorFleet/fabdesk/pull/3",
          author: { login: "mattkanwisher" },
          isDraft: false,
          createdAt: "2026-09-02T07:50:49Z",
          updatedAt: "2026-09-02T08:04:08Z",
          mergeable: "MERGEABLE",
          mergeStateStatus: "MERGING",
          additions: 708,
          deletions: 26,
          headRefName: "cursor/fabplane-password-login-7fd7",
          baseRefName: "main",
        },
      ]),
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 3,
      author: "mattkanwisher",
      headRef: "cursor/fabplane-password-login-7fd7",
    });
  });

  test("digest splits notify vs idle", () => {
    const digest = formatPrDigest([
      classifyPr(pr(), now),
      classifyPr(
        pr({ number: 99, title: "old draft", draft: true, updatedAt: "2026-08-01T00:00:00Z" }),
        now,
      ),
    ]);
    expect(digest).toContain("## Notify");
    expect(digest).toContain("#2");
    expect(digest).toContain("## Idle");
    expect(digest).toContain("#99");
  });
});
