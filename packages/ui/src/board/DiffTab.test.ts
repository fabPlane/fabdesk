import { describe, expect, test } from "bun:test";
import { diffHeadline } from "./diff-copy";

describe("diffHeadline", () => {
  test("summarizes a report", () => {
    expect(
      diffHeadline({
        summary: {
          added: 2,
          removed: 1,
          moved: 1,
          changed: 3,
          netsAdded: 1,
          netsRemoved: 0,
          netsChanged: 2,
        },
      }),
    ).toBe("+2 / −1 / ~3 parts · 1 moved · nets +1/−0/~2");
  });

  test("explains an empty report", () => {
    expect(diffHeadline(null)).toContain("Compare two git revisions");
  });
});
