import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureScreen, enclosureFromTool, type EnclosureView } from "./EnclosurePanel";

const view = (partial: Partial<EnclosureView> = {}): EnclosureView => ({
  exists: true,
  stale: false,
  ok: true,
  summary: "Enclosure 56 × 36 × 12 mm, 2 standoff(s), 1 cutout(s); in sync.",
  issues: [],
  cutouts: [{ ref: "J1", edge: "minY" }],
  holes: 2,
  connectors: 1,
  files: ["enclosure.json", "exports/enclosure.stl"],
  ...partial,
});

const html = (v: EnclosureView | null, extra: { busy?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(EnclosureScreen, {
      view: v,
      busy: extra.busy ?? false,
      error: extra.error ?? null,
      onGenerate: () => {},
      onCheck: () => {},
    }),
  );

describe("EnclosureScreen", () => {
  test("offers generate before a spec exists and regenerate after", () => {
    expect(html(null)).toContain("Generate");
    expect(html(null)).toContain("printable case");
    expect(html(view())).toContain("Regenerate");
    expect(html(view())).toContain("Check alignment");
    expect(html(view())).toContain("In sync");
    expect(html(view())).toContain("exports/enclosure.stl");
  });

  test("warns when the board hash no longer matches", () => {
    const out = html(view({ stale: true, ok: true, issues: ["board changed"] }));
    expect(out).toContain("Board changed");
    expect(out).toContain("cutouts stay aligned");
  });
});

describe("enclosureFromTool", () => {
  test("reads the HTTP tool envelope and a bare json payload", () => {
    const fromHttp = enclosureFromTool({
      ok: true,
      text: "Enclosure ready.\nCutouts: J1.",
      json: {
        exists: true,
        alignment: { ok: true, stale: false, issues: [] },
        cutouts: [{ ref: "J1", edge: "minY" }],
        stl: "exports/enclosure.stl",
        board: { holes: 2, connectors: [{ ref: "J1" }] },
      },
    });
    expect(fromHttp.exists).toBe(true);
    expect(fromHttp.ok).toBe(true);
    expect(fromHttp.cutouts).toEqual([{ ref: "J1", edge: "minY" }]);
    expect(fromHttp.holes).toBe(2);
    expect(fromHttp.files).toContain("exports/enclosure.stl");
  });
});
