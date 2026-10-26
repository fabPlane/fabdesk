import { describe, expect, test } from "bun:test";
import { buildReleaseNotes, parseHandNotes, renderNotesMarkdown, type BuildReleaseNotesInput } from "../release-notes";

const base: BuildReleaseNotesInput = {
  head: "abcdef1234",
  version: "0.2.160",
  date: "2026-10-15T20:00:00Z",
  previousTag: "v0.2.159",
  handNow: [],
  handBefore: [],
  log: ["Update badge downloads the installer (#12)", "Merge pull request #4 from x/y", "Sentry: process tags"],
};

describe("buildReleaseNotes", () => {
  test("uses commit subjects when nothing was written by hand", () => {
    const notes = buildReleaseNotes(base);
    expect(notes.source).toBe("commits");
    expect(notes.id).toBe("0.2.160+abcdef1");
    expect(notes.sections).toEqual([
      { title: "Changes since v0.2.159", items: ["Update badge downloads the installer", "Sentry: process tags"] },
    ]);
  });

  test("hand-written entries added since the previous tag replace the commit list", () => {
    const old = { id: "old", new: ["Shipped last time"] };
    const notes = buildReleaseNotes({
      ...base,
      handBefore: [old],
      handNow: [{ id: "b", fixed: ["Fixed a thing"] }, { id: "a", new: ["A feature"], improved: ["Faster"] }, old],
    });
    expect(notes.source).toBe("hand");
    expect(notes.sections).toEqual([
      { title: "New", items: ["A feature"] },
      { title: "Improved", items: ["Faster"] },
      { title: "Fixed", items: ["Fixed a thing"] },
    ]);
  });

  test("entries already released fall back to commits", () => {
    const old = { id: "old", new: ["Shipped last time"] };
    expect(buildReleaseNotes({ ...base, handBefore: [old], handNow: [old] }).source).toBe("commits");
  });

  test("falls back to a maintenance line", () => {
    expect(buildReleaseNotes({ ...base, previousTag: null, log: [] }).sections).toEqual([
      { title: "Changes", items: ["Maintenance release."] },
    ]);
  });
});

describe("renderNotesMarkdown", () => {
  test("renders the subset fabplane.com understands", () => {
    const md = renderNotesMarkdown(buildReleaseNotes(base), { repo: "TensorFleet/fabdesk", head: "abcdef1234" });
    expect(md).toBe(
      "Changes since v0.2.159:\n\n- Update badge downloads the installer\n- Sentry: process tags\n\nFull diff: https://github.com/TensorFleet/fabdesk/compare/v0.2.159...abcdef1\n",
    );
  });
});

test("the checked-in release-notes.json parses", async () => {
  expect(() => parseHandNotes(require("node:fs").readFileSync(`${import.meta.dirname}/../../release-notes.json`, "utf8"))).not.toThrow();
});
