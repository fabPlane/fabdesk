import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnclosureScreen,
  enclosureFailure,
  enclosureFromTool,
  enclosureDimensionError,
  enclosureDraftChanged,
  enclosureWithSavedPreview,
  parseMm,
  type EnclosureView,
} from "./EnclosurePanel";

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
      draft: extra.draft ??
        v?.draft ?? {
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
  test("saved dimensions do not turn a limited alignment report into a fit claim", () => {
    const out = html(view({ sizeLabel: "21 × 21 × 16.1 mm", cadError: "CAD bridge unavailable" }));
    expect(out).toContain("21 × 21 × 16.1 mm");
    expect(out).not.toContain("in sync");
    expect(out).toContain("Case files were generated, but the CAD model could not be updated");
    expect(out).toContain("CAD bridge unavailable");
    expect(html(view())).not.toContain("in sync");
  });
  test("offers generate before a spec exists and regenerate after", () => {
    expect(html(null)).toContain("Generate");
    expect(html(null)).toContain("printable case");
    expect(html(view())).toContain("Regenerate");
    expect(html(view())).toContain("Check alignment");
    expect(html(view())).toContain("Saved case");
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
    expect(out).toContain("View generated files");
  });

  test("warns when the board hash no longer matches", () => {
    const out = html(view({ stale: true, ok: true, issues: ["board changed"] }));
    expect(out).toContain("PCB changed");
    expect(out).toContain("Review before regenerating");
  });
});

describe("parseMm", () => {
  test("empty clearance uses the fallback, not zero", () => {
    expect(parseMm("", 1)).toBe(1);
    expect(parseMm("   ", 1)).toBe(1);
    expect(parseMm("1.5", 1)).toBe(1.5);
    expect(parseMm("0", 1)).toBe(0);
  });
});

describe("enclosureFromTool", () => {
  test("status without a board is an empty state, not a red alert", () => {
    const fromHttp = enclosureFromTool({
      ok: true,
      text: "No board.kicad_pcb yet. Add a board to generate an enclosure.",
      json: { exists: false, noBoard: true },
    });
    expect(fromHttp.exists).toBe(false);
    expect(fromHttp.summary).toMatch(/No board/);
    const out = html(fromHttp);
    expect(out).toContain("No board.kicad_pcb yet");
    expect(out).not.toContain("In sync");
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain("board.kicad_pcb not found");
  });

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
        params: {
          outlineOffsetMm: 2,
          clearanceMm: 1.5,
          ventPattern: "honeycomb",
          ventFaces: "both",
          snapFit: true,
        },
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
    expect(out).toContain("PCB changed");
    expect(out).toContain("J1 moved 6 mm from its cutout.");
    expect(out).not.toContain("In sync");
    expect(out).not.toContain("{&quot;");
  });

  test("keeps readable text for plain error bodies and non-JSON errors", () => {
    expect(
      enclosureFailure(new Error('{"error":"no board.kicad_pcb","code":"precondition"}')),
    ).toEqual({
      result: null,
      message: "no board.kicad_pcb",
    });
    expect(enclosureFailure(new Error("network down"))).toEqual({
      result: null,
      message: "network down",
    });
  });
});

describe("pending enclosure settings", () => {
  test("ignores equivalent numeric input and restores the saved state", () => {
    const saved = view().draft;
    expect(
      enclosureDraftChanged({ ...saved, outlineOffsetMm: "0.0", clearanceMm: "" }, saved),
    ).toBe(false);
    expect(enclosureDraftChanged({ ...saved, clearanceMm: "2" }, saved)).toBe(true);
    expect(enclosureDraftChanged({ ...saved, snapFit: true }, saved)).toBe(true);
    expect(enclosureDraftChanged({ ...saved, ventPattern: "slots" }, saved)).toBe(true);
    expect(enclosureDraftChanged(saved, saved)).toBe(false);
  });
});

describe("saved enclosure preview", () => {
  test("restores the preview from a status/check response without inline SVG", async () => {
    const status = view({
      files: ["exports/enclosure.stl", "exports/enclosure-preview.svg"],
      stale: true,
    });
    const restored = await enclosureWithSavedPreview(status, async (path) => {
      expect(path).toBe("exports/enclosure-preview.svg");
      return '<svg aria-label="Enclosure preview"></svg>';
    });
    expect(restored.previewSvg).toContain("Enclosure preview");
    expect(restored.stale).toBe(true);
  });
  test("uses fresh generation output and tolerates missing preview files", async () => {
    const generated = view({ previewSvg: "<svg/>" });
    expect(
      await enclosureWithSavedPreview(generated, async () => {
        throw Error("must not read");
      }),
    ).toBe(generated);
    const missing = view({ files: ["exports/enclosure-preview.svg"] });
    expect(
      await enclosureWithSavedPreview(missing, async () => {
        throw Error("404");
      }),
    ).toBe(missing);
  });
});

test("enclosure dimensions explain range errors and allow defaults and boundaries", () => {
  expect(enclosureDimensionError("101", 20, "Clearance")).toBe(
    "Clearance must be between 0 and 20 mm.",
  );
  expect(enclosureDimensionError("-1", 40, "Outline offset")).toContain("0 and 40 mm");
  expect(enclosureDimensionError("Infinity", 20, "Clearance")).not.toBeNull();
  for (const value of ["", "0", "0.5", "20"])
    expect(enclosureDimensionError(value, 20, "Clearance")).toBeNull();
});
