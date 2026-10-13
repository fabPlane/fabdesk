import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureScreen, enclosureFailure, enclosureFromTool, type EnclosureView } from "./EnclosurePanel";

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
  vents: 0,
  clips: 0,
  draft: {
    outlineOffsetMm: "0",
    clearanceMm: "1",
    ventPattern: "none",
    ventFaces: "lid",
    snapFit: false,
  },
  ...partial,
});

const html = (
  v: EnclosureView | null,
  extra: { busy?: boolean; error?: string | null; draft?: EnclosureView["draft"] } = {},
) =>
  renderToStaticMarkup(
    createElement(EnclosureScreen, {
      view: v,
      draft: extra.draft ?? v?.draft ?? {
        outlineOffsetMm: "0",
        clearanceMm: "1",
        ventPattern: "none",
        ventFaces: "lid",
        snapFit: false,
      },
      busy: extra.busy ?? false,
      error: extra.error ?? null,
      onDraftChange: () => {},
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
    expect(html(view())).toContain("Outline offset");
    expect(html(view())).toContain("Clearance");
    expect(html(view())).toContain("Vent pattern");
    expect(html(view())).toContain("Snap-fit clips");
  });

  test("renders a preview and v2 export paths", () => {
    const out = html(
      view({
        previewSvg: '<svg data-testid="enclosure-preview-svg"></svg>',
        vents: 8,
        clips: 4,
        files: ["exports/enclosure.stl", "exports/enclosure.step", "exports/enclosure-preview.svg"],
      }),
    );
    expect(out).toContain("enclosure-preview");
    expect(out).toContain("8 vent(s)");
    expect(out).toContain("4 clip(s)");
    expect(out).toContain("exports/enclosure.step");
    expect(out).toContain("exports/enclosure-preview.svg");
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
    expect(fromHttp.vents).toBe(0);
    expect(fromHttp.draft.ventPattern).toBe("none");
  });

  test("reads v2 params, preview and export paths", () => {
    const fromHttp = enclosureFromTool({
      ok: true,
      text: "Enclosure ready.",
      json: {
        exists: true,
        alignment: { ok: true, stale: false, issues: [] },
        params: { outlineOffsetMm: 2, clearanceMm: 1.5, ventPattern: "honeycomb", ventFaces: "both", snapFit: true },
        vents: 12,
        clips: 4,
        previewSvg: "<svg></svg>",
        stl: "exports/enclosure.stl",
        step: "exports/enclosure.step",
        preview: "exports/enclosure-preview.svg",
        board: { holes: 2, connectors: [{ ref: "J1" }] },
      },
    });
    expect(fromHttp.draft).toEqual({
      outlineOffsetMm: "2",
      clearanceMm: "1.5",
      ventPattern: "honeycomb",
      ventFaces: "both",
      snapFit: true,
    });
    expect(fromHttp.previewSvg).toBe("<svg></svg>");
    expect(fromHttp.vents).toBe(12);
    expect(fromHttp.clips).toBe(4);
    expect(fromHttp.files).toContain("exports/enclosure.step");
    expect(fromHttp.files).toContain("exports/enclosure-preview.svg");
  });
});

describe("enclosureFailure", () => {
  const failedCheck = {
    ok: false,
    text: "Enclosure 56 × 36 × 12 mm; board changed since generation.",
    json: {
      exists: true,
      alignment: {
        ok: false,
        stale: true,
        issues: [
          { code: "stale-board", message: "Board changed since the enclosure was generated." },
          { code: "moved-cutout", ref: "J1", message: "J1 moved 6 mm from its cutout." },
        ],
      },
      cutouts: [{ ref: "J1", edge: "minY" }],
      stl: "exports/enclosure.stl",
    },
  };

  test("turns a thrown 422 alignment envelope into a stale view without raw JSON", () => {
    const failure = enclosureFailure(new Error(JSON.stringify(failedCheck)));
    expect(failure.message).toBe("");
    const v = enclosureFromTool(failure.result);
    expect(v.stale).toBe(true);
    expect(v.ok).toBe(false);
    const out = html(v);
    expect(out).toContain("Board changed");
    expect(out).toContain("J1 moved 6 mm from its cutout.");
    expect(out).not.toContain("In sync");
    expect(out).not.toContain("{&quot;");
  });

  test("keeps readable text for plain error bodies and non-JSON errors", () => {
    expect(enclosureFailure(new Error('{"error":"no board.kicad_pcb","code":"precondition"}'))).toEqual({
      result: null,
      message: "no board.kicad_pcb",
    });
    expect(enclosureFailure(new Error("network down"))).toEqual({ result: null, message: "network down" });
  });
});
