import { describe, expect, test } from "bun:test";
import type { ReleaseNotes } from "@fabdesk/protocol";
import { hasUnseenReleaseNotes } from "./WhatsNew";

const notes: ReleaseNotes = {
  id: "0.2.160+abcdef1",
  version: "0.2.160",
  date: "2026-10-15T20:00:00Z",
  previousTag: "v0.2.159",
  source: "commits",
  sections: [{ title: "Changes since v0.2.159", items: ["A change"] }],
};

describe("What's new link", () => {
  test("shows until this build's notes are opened", () => {
    expect(hasUnseenReleaseNotes(notes, null)).toBe(true);
    expect(hasUnseenReleaseNotes(notes, "0.2.159+1234567")).toBe(true);
    expect(hasUnseenReleaseNotes(notes, notes.id)).toBe(false);
  });
  test("never shows for a build without notes", () => {
    expect(hasUnseenReleaseNotes(undefined, null)).toBe(false);
  });
});
