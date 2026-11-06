import { expect, test } from "bun:test";
import {
  openSharedProjectHref,
  parseSharedProjectHref,
  ProjectShareState,
  ProjectShareSnapshot,
} from "./project-sharing";
const id = "share_0123456789abcdef";
test("desktop links accept only exact share destinations", () => {
  expect(parseSharedProjectHref(openSharedProjectHref(id))).toEqual({ shareId: id });
  expect(parseSharedProjectHref(`https://app.fabplane.com/share/${id}`)).toEqual({ shareId: id });
  for (const href of [
    `https://evil.test/share/${id}`,
    `https://app.fabplane.com/${id}`,
    `fabplane://share/${id}?url=https://evil.test`,
    `fabplane://share/../../etc/passwd`,
    `fabplane://share/${id}/edit`,
    `https://user@app.fabplane.com/share/${id}`,
    "file:///tmp/project",
  ])
    expect(parseSharedProjectHref(href)).toBeNull();
});
test("published settings require server publication evidence", () => {
  expect(ProjectShareState.safeParse({ visibility: "unlisted" }).success).toBe(false);
  expect(ProjectShareState.safeParse({ visibility: "private", shareId: id }).success).toBe(false);
});
test("public snapshot contract rejects accidental local fields", () => {
  expect(
    ProjectShareSnapshot.safeParse({
      schema: "fabplane.project-share.v1",
      name: "Board",
      capturedAt: new Date().toISOString(),
      boards: [],
      path: "/private/project",
    }).success,
  ).toBe(false);
});
