import type { BoardConstructionId, BoardMaterialId, BoardSettings, PedestalPad, RectMm } from "@fabdesk/protocol";
import { boardMaterialSummary, resolveBoardMaterial } from "@fabdesk/protocol";
import { MATERIAL_PRESETS, resolveConstruction, validateMaterialChoice } from "./presets";
import { applyRulesToPro, applyStackupToPcb, copperLayerCountFromPcb, readBoardThicknessMm, readStackupSummary } from "./pcb-text";
import type { MaterialApplyPlan, StackupDiffLine } from "./types";

export function planMaterialApply(opts: {
  material?: BoardMaterialId;
  construction?: BoardConstructionId;
  layers?: number;
  current?: BoardSettings;
  pcbText?: string;
  bendZones?: RectMm[];
  pedestalPads?: PedestalPad[];
}): MaterialApplyPlan {
  const material = resolveBoardMaterial(opts.material ?? opts.current?.material);
  const validated = validateMaterialChoice(material, opts.construction ?? opts.current?.construction, opts.layers);
  if (!validated.ok) throw new Error(validated.error);
  const construction = resolveConstruction(material, validated.construction);
  const summary = boardMaterialSummary(material);
  const preset = MATERIAL_PRESETS[material];
  const current = opts.current;
  const pcbSummary = opts.pcbText ? readStackupSummary(opts.pcbText) : [];
  const pcbLayers = opts.pcbText ? copperLayerCountFromPcb(opts.pcbText) : current?.layers;
  const pcbThickness = opts.pcbText ? readBoardThicknessMm(opts.pcbText) : undefined;
  const fromMaterial = current?.material ?? (pcbSummary.some((l) => /polyimide|RO4350|PTFE|Aluminium|Copper C110/i.test(l.material ?? "")) ? "custom" : "fr4");
  const diff: StackupDiffLine[] = [];
  const add = (field: string, from: string, to: string) => {
    if (from !== to) diff.push({ field, from, to });
  };
  add("material", String(fromMaterial), material);
  add("construction", current?.construction ?? "—", construction.id);
  add("copperLayers", String(pcbLayers ?? current?.layers ?? "—"), String(construction.copperLayers));
  add("thicknessMm", String(pcbThickness ?? "—"), String(construction.thicknessMm));
  add("traceWidthMm", String(current?.rules?.traceWidthMm ?? "—"), String(construction.rules.traceWidthMm ?? "—"));
  add("clearanceMm", String(current?.rules?.clearanceMm ?? "—"), String(construction.rules.clearanceMm ?? "—"));
  add("finish", pcbSummary.length ? "board file" : "unset", summary.appearance.finish);
  const dielectrics = construction.layers.filter((l) => l.er !== undefined);
  if (dielectrics[0]) add("Dk", pcbSummary.find((l) => l.er)?.er?.toString() ?? "—", String(dielectrics[0].er));
  return {
    material,
    construction: construction.id,
    copperLayers: construction.copperLayers,
    thicknessMm: construction.thicknessMm,
    rules: construction.rules,
    stackup: construction.layers,
    appearance: {
      soldermask: summary.appearance.soldermask,
      silkscreen: summary.appearance.silkscreen,
      finish: summary.appearance.finish,
      substrate: summary.appearance.substrate,
    },
    fabNotes: preset.fabNotes,
    specialistFab: summary.specialistFab,
    impedance: construction.impedance,
    userLayers: preset.userLayers,
    bendZones: opts.bendZones ?? current?.bendZones ?? [],
    pedestalPads: opts.pedestalPads ?? current?.pedestalPads ?? [],
    diff,
  };
}

export function applyPlanToPcb(pcbText: string, plan: MaterialApplyPlan): string {
  return applyStackupToPcb(pcbText, plan);
}

export function applyPlanToPro(proText: string | undefined, plan: MaterialApplyPlan): string {
  return applyRulesToPro(proText, plan);
}

export function boardSettingsFromPlan(current: BoardSettings, plan: MaterialApplyPlan): BoardSettings {
  const { template: _t, ...rest } = current;
  return {
    ...rest,
    layers: plan.copperLayers,
    rules: {
      ...(current.rules ?? {}),
      ...(plan.rules.traceWidthMm !== undefined ? { traceWidthMm: plan.rules.traceWidthMm } : {}),
      ...(plan.rules.clearanceMm !== undefined ? { clearanceMm: plan.rules.clearanceMm } : {}),
      ...(plan.rules.viaDiameterMm !== undefined ? { viaDiameterMm: plan.rules.viaDiameterMm } : {}),
      ...(plan.rules.viaDrillMm !== undefined ? { viaDrillMm: plan.rules.viaDrillMm } : {}),
    },
    material: plan.material,
    construction: plan.construction,
    ...(plan.bendZones.length ? { bendZones: plan.bendZones } : {}),
    ...(plan.pedestalPads.length ? { pedestalPads: plan.pedestalPads } : {}),
    ...(current.template ? { template: current.template } : {}),
    ...(current.widthMm !== undefined ? { widthMm: current.widthMm } : {}),
    ...(current.heightMm !== undefined ? { heightMm: current.heightMm } : {}),
  };
}

export function describePlan(plan: MaterialApplyPlan): string {
  const summary = boardMaterialSummary(plan.material);
  const lines = [
    `${summary.name} (${plan.construction}): ${plan.copperLayers} copper layers, ${plan.thicknessMm} mm, ${plan.appearance.finish}.`,
    `Rules: track ${plan.rules.traceWidthMm ?? "—"} mm, clearance ${plan.rules.clearanceMm ?? "—"} mm, vias ${plan.rules.viaPolicy}.`,
    `50 Ω width on ${plan.impedance.single50.layer}: ${plan.impedance.single50.widthMm} mm (Dk ${plan.stackup.find((l) => l.er)?.er ?? "—"}).`,
  ];
  if (plan.specialistFab) {
    lines.push("This construction is not a standard FR-4 order — download the files for a specialist fab.");
  }
  if (plan.diff.length) {
    lines.push("Diff:");
    for (const d of plan.diff) lines.push(`- ${d.field}: ${d.from} → ${d.to}`);
  }
  return lines.join("\n");
}
