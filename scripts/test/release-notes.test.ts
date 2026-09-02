import { describe, expect, test } from "bun:test";
import { buildNotes } from "../release-notes";

describe("buildNotes", () => {
  test("lists commit subjects, drops merges, links the diff", () => {
    const notes = buildNotes({
      head: "abcdef1234",
      previousTag: "v0.1.19",
      repo: "TensorFleet/fabdesk",
      log: ["Update badge downloads the installer (#12)", "Merge pull request #4 from x/y", "Sentry: process tags"],
    });
    expect(notes).toContain("Changes since v0.1.19:");
    expect(notes).toContain("- Update badge downloads the installer");
    expect(notes).toContain("- Sentry: process tags");
    expect(notes).not.toContain("Merge pull request");
    expect(notes).toContain("compare/v0.1.19...abcdef1");
  });
  test("falls back to a maintenance line", () => {
    expect(buildNotes({ head: "x", previousTag: null, log: [] })).toBe("- Maintenance release.\n");
  });
});
