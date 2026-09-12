import { describe, expect, test } from "bun:test";
import { groupProjectsByFolder, parentDir, shortenHome } from "./project-groups";

const project = (id: string, path: string, updatedAt: string) => ({
  id,
  name: id,
  path,
  createdAt: updatedAt,
  updatedAt,
});

describe("paths", () => {
  test("parentDir handles trailing slashes, roots and Windows", () => {
    expect(parentDir("/Users/maya/fabdesk/blinky")).toBe("/Users/maya/fabdesk");
    expect(parentDir("/Users/maya/fabdesk/blinky/")).toBe("/Users/maya/fabdesk");
    expect(parentDir("/blinky")).toBe("/");
    expect(parentDir("C:\\Users\\maya\\fabdesk\\blinky")).toBe("C:\\Users\\maya\\fabdesk");
  });

  test("shortenHome", () => {
    expect(shortenHome("/Users/maya/fabdesk")).toBe("~/fabdesk");
    expect(shortenHome("/home/maya")).toBe("~");
    expect(shortenHome("/Users/mayank")).toBe("~");
    expect(shortenHome("/Users")).toBe("/Users");
    expect(shortenHome("/srv/boards")).toBe("/srv/boards");
    expect(shortenHome("C:\\Users\\maya\\fabdesk")).toBe("~\\fabdesk");
  });
});

describe("groupProjectsByFolder", () => {
  test("groups by parent directory, titles sorted, newest project first in each", () => {
    const groups = groupProjectsByFolder([
      project("old", "/Users/maya/fabdesk/old", "2026-09-01T00:00:00Z"),
      project("imported", "/Users/maya/work/imported", "2026-09-03T00:00:00Z"),
      project("new", "/Users/maya/fabdesk/new", "2026-09-02T00:00:00Z"),
    ]);
    expect(groups.map((g) => [g.title, g.projects.map((p) => p.id)])).toEqual([
      ["~/fabdesk", ["new", "old"]],
      ["~/work", ["imported"]],
    ]);
  });

  test("empty in, empty out", () => {
    expect(groupProjectsByFolder([])).toEqual([]);
  });
});
