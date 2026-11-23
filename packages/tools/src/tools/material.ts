/** Board material presets: list / get / set with a dry-run stackup+rules diff. */
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { BoardConstructionId, BoardMaterialId, PedestalPad, RectMm } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, writeAtomic } from "../fs";
import { ToolError, defineTool } from "../registry";
import {
  applyPlanToPcb,
  applyPlanToPro,
  boardSettingsFromPlan,
  describePlan,
  listMaterialPresets,
  planMaterialApply,
  resolveConstruction,
} from "../materials";
import { ok, p } from "./common";

const ANNOTATIONS_RO = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const ANNOTATIONS_RW = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export const board_material_list = defineTool({
  name: "board_material_list",
  toolset: "core",
  scope: "global",
  title: "List board materials",
  description:
    "List the board laminate presets (FR-4, flex, aluminium, copper core, Rogers, PTFE, HDI) with short when-to-use copy, constructions, and whether a specialist fab is required.",
  inputSchema: {},
  annotations: ANNOTATIONS_RO,
  handler: async () => {
    const materials = listMaterialPresets();
    const lines = [
      "Board materials:",
      ...materials.map(
        (m) =>
          `- ${m.id}: ${m.name} — ${m.blurb} Constructions: ${m.constructions.map((c) => c.id).join(", ")}.${m.specialistFab ? " Specialist fab." : ""}`,
      ),
    ];
    return ok(lines.join("\n"), { materials });
  },
});

export const board_material_get = defineTool({
  name: "board_material_get",
  toolset: "core",
  title: "Get the project board material",
  description:
    "Return the project's current board material (from fabdesk.json; FR-4 when unset), the resolved construction, stackup, rules, and computed 50 Ω / differential widths.",
  inputSchema: {},
  annotations: ANNOTATIONS_RO,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const board = project.manifest().board;
    const pcb = p(project, PROJECT_FILES.boardPcb);
    const pcbText = (await exists(pcb)) ? await readFile(pcb, "utf8") : undefined;
    const plan = planMaterialApply({
      ...(board.material ? { material: board.material } : {}),
      ...(board.construction ? { construction: board.construction } : {}),
      current: board,
      ...(pcbText ? { pcbText } : {}),
    });
    return ok(describePlan(plan), {
      explicit: Boolean(board.material),
      plan,
    });
  },
});

export const board_material_set = defineTool({
  name: "board_material_set",
  toolset: "core",
  title: "Set the project board material",
  description:
    "Choose a board laminate preset and write it to fabdesk.json. When board.kicad_pcb exists, rewrite the KiCad stackup, copper layer list, thickness, finish, and design-rule floors. dryRun=true returns the stackup+rules diff without writing. Explain the choice when picking from a brief. Override with the UI or by calling this again.",
  inputSchema: {
    material: BoardMaterialId.describe("Preset id: fr4, flex, aluminium, copper_core, rogers, ptfe, hdi"),
    construction: BoardConstructionId.optional().describe("2l / 4l / 6l / 1l / hybrid; default for the material if omitted"),
    dryRun: z.boolean().default(false).describe("Return the stackup and rules diff without writing"),
    reason: z.string().optional().describe("Why this material was chosen (shown to the user)"),
    bendZones: z.array(RectMm).optional().describe("Flex bend keepouts in mm (board frame)"),
    pedestalPads: z.array(PedestalPad).optional().describe("Copper-core thermal pads (ref + pad)"),
  },
  annotations: ANNOTATIONS_RW,
  handler: async ({ material, construction, dryRun, reason, bendZones, pedestalPads }, ctx) => {
    const project = ctx.requireProject();
    const current = project.manifest().board;
    const pcb = p(project, PROJECT_FILES.boardPcb);
    const pro = p(project, PROJECT_FILES.boardPro);
    const pcbText = (await exists(pcb)) ? await readFile(pcb, "utf8") : undefined;
    try {
      resolveConstruction(material, construction);
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
    }
    const plan = planMaterialApply({
      material,
      ...(construction ? { construction } : {}),
      current,
      ...(pcbText ? { pcbText } : {}),
      ...(bendZones ? { bendZones } : {}),
      ...(pedestalPads ? { pedestalPads } : {}),
    });
    const written: string[] = [];
    if (!dryRun) {
      const nextBoard = boardSettingsFromPlan(current, plan);
      await project.updateManifest({ board: nextBoard });
      written.push(PROJECT_FILES.manifest);
      if (pcbText !== undefined) {
        await writeAtomic(pcb, applyPlanToPcb(pcbText, plan));
        written.push(PROJECT_FILES.boardPcb);
      }
      if (await exists(pro)) {
        await writeAtomic(pro, applyPlanToPro(await readFile(pro, "utf8"), plan));
        written.push(PROJECT_FILES.boardPro);
      } else if (pcbText !== undefined) {
        await writeAtomic(pro, applyPlanToPro(undefined, plan));
        written.push(PROJECT_FILES.boardPro);
      }
    }
    const text = [
      dryRun ? "Dry run — nothing written." : `Set board material to ${plan.material} / ${plan.construction}.`,
      ...(reason ? [`Choice: ${reason}`] : []),
      describePlan(plan),
      written.length ? `Wrote ${written.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(text, { dryRun, plan, written, reason: reason ?? null });
  },
});

export const materialTools = [board_material_list, board_material_get, board_material_set];
