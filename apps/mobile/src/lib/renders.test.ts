import { describe, expect, test } from "bun:test";
import type { ProjectDetail } from "@fabdesk/protocol";
import {
  galleryRenders,
  hasBoard,
  isPreviousRender,
  preferredRender,
  previousRenderKey,
  renderImages,
  renderView,
} from "./renders";

function project(files: Array<[string, string]>): ProjectDetail {
  return {
    id: "p1",
    name: "blinky",
    path: "/tmp/blinky",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    manifest: {
      schema: 1,
      id: "p1",
      name: "blinky",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      board: { layers: 2 },
      router: "capacity",
      agent: {},
      allowedDrcWarnings: [],
    },
    files: files.map(([path, mtime]) => ({ path, size: 100, mtime })),
  };
}

describe("renderImages / preferredRender", () => {
  test("only renders/*.png|jpg, newest first", () => {
    const p = project([
      ["renders/top.png", "2026-09-02T10:00:00Z"],
      ["renders/schematic.svg", "2026-09-02T11:00:00Z"],
      ["renders/bottom.png", "2026-09-02T12:00:00Z"],
      ["sketches/a.png", "2026-09-02T13:00:00Z"],
    ]);
    expect(renderImages(p).map((f) => f.path)).toEqual(["renders/bottom.png", "renders/top.png"]);
    expect(preferredRender(p)?.path).toBe("renders/top.png");
    expect(preferredRender(undefined)).toBeNull();
  });

  test("hasBoard looks for a kicad_pcb", () => {
    expect(hasBoard(project([["board.kicad_pcb", "2026-09-02T10:00:00Z"]]))).toBe(true);
    expect(hasBoard(project([["circuit.tsx", "2026-09-02T10:00:00Z"]]))).toBe(false);
  });
});

describe("gallery", () => {
  test("renderView strips directory and extension", () => {
    expect(renderView("renders/top.png")).toBe("top");
    expect(renderView("renders/Board-perspective.jpeg")).toBe("Board-perspective");
    expect(renderView("x")).toBe("x");
  });

  test("known views come first in a fixed order, then the rest alphabetically", () => {
    const p = project([
      ["renders/zeta.png", "2026-09-02T14:00:00Z"],
      ["renders/side.png", "2026-09-02T13:00:00Z"],
      ["renders/top.png", "2026-09-02T10:00:00Z"],
      ["renders/alpha.png", "2026-09-02T12:00:00Z"],
      ["renders/bottom.png", "2026-09-02T11:00:00Z"],
    ]);
    expect(galleryRenders(p).map((f) => renderView(f.path))).toEqual([
      "top",
      "bottom",
      "side",
      "alpha",
      "zeta",
    ]);
  });
});

describe("previous render cache", () => {
  const current = { path: "renders/top.png", size: 1, mtime: "2026-09-02T12:00:00Z" };

  test("a cache older than the current file is a genuine before", () => {
    expect(isPreviousRender(current, { uri: "file:///x", mtime: "2026-09-02T11:00:00Z" })).toBe(
      true,
    );
  });

  test("same mtime means nothing was re-rendered since the cache was taken", () => {
    expect(isPreviousRender(current, { uri: "file:///x", mtime: current.mtime })).toBe(false);
    expect(isPreviousRender(current, null)).toBe(false);
    expect(isPreviousRender(current, { uri: "file:///x", mtime: "garbage" })).toBe(false);
  });

  test("cache key is one flat filename per project + path", () => {
    expect(previousRenderKey("prj_1", "renders/top.png")).toBe("prj_1__renders_top.png");
    expect(previousRenderKey("prj_1", "renders/top.png")).not.toContain("/");
  });
});
