import { boardMaterialSummary } from "@fabdesk/protocol";
import type { MaterialApplyPlan } from "./types";

export function materialSpecBlock(plan: MaterialApplyPlan): string {
  const summary = boardMaterialSummary(plan.material);
  const lines = [
    "fabPlane material spec",
    "======================",
    `Material: ${summary.name} (${plan.material})`,
    `Construction: ${plan.construction}`,
    `Copper layers: ${plan.copperLayers}`,
    `Finished thickness: ${plan.thicknessMm} mm`,
    `Finish: ${plan.appearance.finish}`,
    `Soldermask: ${plan.appearance.soldermask}`,
    `Silkscreen: ${plan.appearance.silkscreen}`,
  ];
  const d = plan.stackup.find((l) => l.er !== undefined);
  if (d) {
    lines.push(`Dielectric: ${d.material ?? d.name}`);
    lines.push(`Dk: ${d.er}`);
    lines.push(`Df: ${d.tand ?? "—"}`);
    lines.push(`Dielectric thickness: ${d.thicknessMm} mm`);
  }
  if (plan.userLayers.length) {
    lines.push("User layers:");
    for (const u of plan.userLayers) lines.push(`- ${u.name}: ${u.purpose}`);
  }
  if (plan.rules.microviaDrillMm) {
    lines.push(`Microvia: ${plan.rules.microviaDrillMm} mm drill / ${plan.rules.microviaDiameterMm ?? "—"} mm pad`);
  }
  if (plan.rules.minBendRadiusMm) lines.push(`Minimum bend radius: ${plan.rules.minBendRadiusMm} mm`);
  lines.push("");
  lines.push("Impedance (computed from this stackup)");
  lines.push(`- 50 Ω single-ended on ${plan.impedance.single50.layer}: ${plan.impedance.single50.widthMm} mm`);
  lines.push(`- 90 Ω differential: ${plan.impedance.diff90.widthMm} mm, gap ${plan.impedance.diff90.gapMm ?? "—"} mm`);
  lines.push(`- 100 Ω differential: ${plan.impedance.diff100.widthMm} mm, gap ${plan.impedance.diff100.gapMm ?? "—"} mm`);
  lines.push("");
  lines.push("Fab notes");
  for (const n of plan.fabNotes) lines.push(`- ${n}`);
  if (plan.specialistFab) {
    lines.push("- This is not a standard FR-4 order. Quote it with a flex, metal-core, or RF house.");
  }
  return `${lines.join("\n")}\n`;
}

export function stackupDrawing(plan: MaterialApplyPlan): string {
  const width = 56;
  const lines = [
    "Stackup drawing (top → bottom)",
    "------------------------------",
  ];
  for (const l of plan.stackup) {
    const label = `${l.name}  ${l.kind}${l.material ? `  ${l.material}` : ""}${l.er !== undefined ? `  Dk ${l.er}` : ""}  ${l.thicknessMm} mm`;
    const bar = l.kind === "copper" ? "█" : l.kind === "metal_base" ? "▓" : l.kind === "dielectric" || l.kind === "coverlay" ? "░" : "─";
    lines.push(bar.repeat(Math.min(width, 24)).padEnd(26) + label);
  }
  lines.push(`Total ${plan.thicknessMm} mm`);
  return `${lines.join("\n")}\n`;
}

export function fabNotesPackage(plan: MaterialApplyPlan): { spec: string; drawing: string } {
  return { spec: materialSpecBlock(plan), drawing: stackupDrawing(plan) };
}
