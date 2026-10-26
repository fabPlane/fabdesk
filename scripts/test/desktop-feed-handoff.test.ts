import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");

describe("desktop feed handoff locator", () => {
  test("pipes gh run list JSON into jq --argjson (gh --jq does not take --argjson)", () => {
    const website = workflow.slice(workflow.indexOf("name: Hand off public release to fabplane.com"));
    expect(website).toContain("gh run list");
    expect(website).toContain("jq --argjson since");
    expect(website).not.toContain("--jq --argjson");
    expect(website).toContain("fromdateiso8601");
  });

  test("polls run status with gh run view (fine-grained PATs cannot use gh run watch)", () => {
    const website = workflow.slice(workflow.indexOf("name: Hand off public release to fabplane.com"));
    expect(website).toContain("gh run view");
    expect(website).toContain("--json status,conclusion");
    expect(website).not.toContain('gh run watch "$run_id"');
  });

  test("55-minute poll deadline starts after the run leaves queued", () => {
    const website = workflow.slice(workflow.indexOf("name: Hand off public release to fabplane.com"));
    expect(website).toContain('timeout-minutes: 120');
    expect(website).toContain('deadline=""');
    expect(website).toContain('[ "$status" != "queued" ]');
    expect(website).toContain("3300");
  });

  test("feed poll outlasts the 300-second /desktop/* cache", () => {
    const website = workflow.slice(workflow.indexOf("name: Hand off public release to fabplane.com"));
    const feed = website.slice(website.indexOf("expected="));
    expect(feed).toContain("seq 1 60");
    expect(feed).not.toContain("seq 1 20");
    const attempts = Number(/for attempt in \$\(seq 1 (\d+)\)/.exec(feed)?.[1]);
    expect(Number.isInteger(attempts)).toBe(true);
    // First probe is immediate; the last starts after (N-1)*15 seconds.
    expect((attempts - 1) * 15).toBeGreaterThan(300);
  });
});
