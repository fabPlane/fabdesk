import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, makeContext } from "../src";
import {
  applyPlanToPcb,
  applyStackupToPcb,
  checkMaterialBoard,
  copperLayerCountFromPcb,
  fabNotesPackage,
  listMaterialPresets,
  MATERIAL_PRESETS,
  microstripWidthMm,
  planMaterialApply,
  readBoardThicknessMm,
  readStackupSummary,
  resolveConstruction,
  selectMaterialFromBrief,
  validateMaterialChoice,
} from "../src/materials";
import { mockServices, tempProject } from "./mock-services";

function fixturePcb(opts?: {
  via?: { x: number; y: number };
  pad?: { ref: string; pad: string; type: string; x: number; y: number; layer?: string };
  footprintLayer?: string;
  track?: { net: string; width: number };
}): string {
  const via = opts?.via
    ? `\t(via (at ${opts.via.x} ${opts.via.y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "v1"))\n`
    : "";
  const pad = opts?.pad
    ? `\t(footprint "Package:QFN" (layer "${opts.footprintLayer ?? opts.pad.layer ?? "F.Cu"}")
\t\t(at ${opts.pad.x} ${opts.pad.y})
\t\t(property "Reference" "${opts.pad.ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "r1"))
\t\t(pad "${opts.pad.pad}" ${opts.pad.type} rect (at 0 0) (size 1.2 1.2) (drill 0.3) (layers "*.Cu" "*.Mask") (net 1 "EP"))
\t)`
    : "";
  const track = opts?.track
    ? `\t(segment (start 0 0) (end 8 0) (width ${opts.track.width}) (layer "F.Cu") (net "${opts.track.net}"))\n`
    : "";
  return `(kicad_pcb
\t(version 20241229)
\t(generator "fabdesk")
\t(general
\t\t(thickness 1.6)
\t)
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(31 "B.Cu" signal)
\t)
\t(setup
\t\t(stackup
\t\t\t(layer "F.Cu" (type copper) (thickness 0.035))
\t\t\t(layer "dielectric 1" (type core) (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
\t\t\t(layer "B.Cu" (type copper) (thickness 0.035))
\t\t\t(copper_finish "ENIG")
\t\t)
\t)
${via}${pad}${track})
`;
}

describe("material presets", () => {
  test("every construction has a stackup, rules, and computed 50 Ω width", () => {
    const listed = listMaterialPresets();
    expect(listed.map((m) => m.id)).toEqual(["fr4", "flex", "aluminium", "copper_core", "rogers", "ptfe", "hdi"]);
    for (const summary of listed) {
      const preset = MATERIAL_PRESETS[summary.id];
      expect(preset.constructions[preset.defaultConstruction]).toBeDefined();
      for (const id of summary.constructions.map((c) => c.id)) {
        const c = resolveConstruction(summary.id, id);
        expect(c.copperLayers).toBeGreaterThan(0);
        expect(c.thicknessMm).toBeGreaterThan(0);
        expect(c.impedance.single50.widthMm).toBeGreaterThan(0.04);
        expect(c.layers.some((l) => l.kind === "copper")).toBe(true);
      }
    }
    expect(validateMaterialChoice("flex", "6l").ok).toBe(false);
    expect(validateMaterialChoice("fr4", "2l", 2).ok).toBe(true);
    expect(validateMaterialChoice("hdi", "6l", 2).ok).toBe(false);
  });

  test("Rogers 50 Ω width uses Dk 3.48, not FR-4 4.5", () => {
    const rogers = resolveConstruction("rogers", "2l");
    const fr4 = resolveConstruction("fr4", "2l");
    const d = rogers.layers.find((l) => l.er !== undefined)!;
    expect(d.er).toBe(3.48);
    expect(rogers.impedance.single50.widthMm).not.toBe(fr4.impedance.single50.widthMm);
    expect(rogers.impedance.single50.widthMm).toBe(
      Math.round(microstripWidthMm({ z0: 50, er: 3.48, heightMm: 0.508, copperMm: 0.035 }) * 1000) / 1000,
    );
  });
});

describe("stackup rewrite", () => {
  test("setting a material rewrites KiCad stackup and thickness (round-trip)", () => {
    const start = fixturePcb();
    const plan = planMaterialApply({ material: "flex", construction: "2l", pcbText: start });
    const next = applyStackupToPcb(start, plan);
    expect(readBoardThicknessMm(next)).toBe(plan.thicknessMm);
    expect(copperLayerCountFromPcb(next)).toBe(2);
    const summary = readStackupSummary(next);
    expect(summary.some((l) => /polyimide/i.test(l.material ?? ""))).toBe(true);
    expect(summary.some((l) => l.er === 3.4)).toBe(true);
    expect(next).toContain("User.3");
    const again = applyPlanToPcb(next, plan);
    expect(readStackupSummary(again).map((l) => l.name)).toEqual(readStackupSummary(next).map((l) => l.name));
  });

  test("aluminium stackup is single-sided and names the metal base", () => {
    const plan = planMaterialApply({ material: "aluminium" });
    const next = applyStackupToPcb(fixturePcb(), plan);
    expect(copperLayerCountFromPcb(next)).toBe(1);
    expect(readStackupSummary(next).some((l) => /Aluminium/i.test(l.material ?? ""))).toBe(true);
  });
});

describe("material checks", () => {
  test("via in a flex bend zone", () => {
    const pcb = fixturePcb({ via: { x: 5, y: 5 } });
    const plan = planMaterialApply({ material: "flex", bendZones: [{ x1: 0, y1: 0, x2: 10, y2: 10 }] });
    const hits = checkMaterialBoard(pcb, plan);
    expect(hits.some((v) => v.kind === "via_in_bend_zone")).toBe(true);
  });

  test("PTH on aluminium core", () => {
    const pcb = fixturePcb({ pad: { ref: "J1", pad: "1", type: "thru_hole", x: 2, y: 2 } });
    const plan = planMaterialApply({ material: "aluminium" });
    const hits = checkMaterialBoard(pcb, plan);
    expect(hits.some((v) => v.kind === "pth_on_metal_core")).toBe(true);
  });

  test("wrong impedance width for Rogers Dk", () => {
    const pcb = fixturePcb({ track: { net: "RF", width: 0.2 } });
    const plan = planMaterialApply({ material: "rogers", construction: "2l" });
    const hits = checkMaterialBoard(pcb, plan);
    expect(hits.some((v) => v.kind === "impedance_width")).toBe(true);
    expect(hits.find((v) => v.kind === "impedance_width")?.detail).toMatch(/Dk 3\.48/);
  });
});

describe("agent material selection", () => {
  test("deterministic heuristic from sample briefs", () => {
    expect(selectMaterialFromBrief("a flexible temperature probe").id).toBe("flex");
    expect(selectMaterialFromBrief("24 GHz radar front-end").id).toBe("ptfe");
    expect(selectMaterialFromBrief("LED panel that runs hot").id).toBe("aluminium");
    expect(selectMaterialFromBrief("fine-pitch BGA with microvias").id).toBe("hdi");
    expect(selectMaterialFromBrief("2.4 GHz power amplifier on Rogers").id).toBe("rogers");
    expect(selectMaterialFromBrief("copper core pedestal LED engine").id).toBe("copper_core");
    expect(selectMaterialFromBrief("a blinking LED badge").id).toBe("fr4");
  });

  test("mocked LLM is used only when the heuristic is silent", () => {
    const llm = () =>
      ({
        id: "ptfe" as const,
        construction: "2l" as const,
        confidence: "high" as const,
        reason: "mocked",
        source: "llm" as const,
      });
    expect(selectMaterialFromBrief("flexible probe", llm).source).toBe("heuristic");
    expect(selectMaterialFromBrief("something vague about a sensor", llm)).toMatchObject({
      id: "ptfe",
      source: "llm",
    });
  });
});

describe("MCP board_material tools", () => {
  test("list / get / set dry-run and apply", async () => {
    const project = await tempProject("mat");
    await mkdir(join(project.dir, "exports", "gerbers"), { recursive: true });
    await writeFile(join(project.dir, "board.kicad_pcb"), fixturePcb());
    await writeFile(join(project.dir, "exports", "gerbers", "F_Cu.gbr"), "G04*\n");
    const services = mockServices([project]);
    const registry = createRegistry();
    const invoke = (name: string, args: unknown = {}) =>
      registry.invoke(name, args, () => makeContext({ services, project }));

    const list = await invoke("board_material_list");
    expect(list.text).toContain("fr4:");
    expect((list.json as { materials: Array<{ id: string }> }).materials).toHaveLength(7);

    const get = await invoke("board_material_get");
    expect(get.text).toMatch(/FR-4/i);

    const dry = await invoke("board_material_set", { material: "rogers", construction: "2l", dryRun: true });
    expect(dry.text).toContain("Dry run");
    expect(project.manifest().board.material).toBeUndefined();

    const set = await invoke("board_material_set", {
      material: "rogers",
      construction: "2l",
      dryRun: false,
      reason: "5.8 GHz front-end",
    });
    expect(set.text).toContain("5.8 GHz");
    expect(project.manifest().board.material).toBe("rogers");
    const pcb = await readFile(join(project.dir, "board.kicad_pcb"), "utf8");
    expect(readStackupSummary(pcb).some((l) => l.material === "RO4350B")).toBe(true);

    const verify = await invoke("verify_material");
    expect(verify.isError).toBeFalsy();

    const zip = await invoke("export_zip", { filename: "fabrication.zip" });
    expect((zip.json as { files: string[] }).files).toContain("fab-notes.txt");
    expect((zip.json as { files: string[] }).files).toContain("stackup.txt");
    const spec = await readFile(join(project.dir, "exports", "fab-notes.txt"), "utf8");
    expect(spec).toContain("RO4350B");
    expect(spec).toContain("Dk:");
    const drawing = fabNotesPackage(planMaterialApply({ material: "rogers" })).drawing;
    expect(drawing).toContain("Stackup drawing");
  });
});
