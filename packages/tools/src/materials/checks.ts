import type { BoardMaterialId, PedestalPad, RectMm } from "@fabdesk/protocol";
import { extractBoardGeometry, isPedestal, pointInPolygon, pointInRect } from "./pcb-text";
import { microstripZ0 } from "./impedance";
import type { MaterialApplyPlan, MaterialViolation } from "./types";

const RF_NET = /(50\s*ohm|50ohm|\brf\b|\bant\b|z50|50r)/i;
const WIDTH_TOLERANCE = 0.15;

function inBend(x: number, y: number, zones: RectMm[], keepouts: Array<{ name: string; points: Array<{ x: number; y: number }> }>): boolean {
  if (zones.some((z) => pointInRect(x, y, z))) return true;
  return keepouts.some((k) => /bend/i.test(k.name) && pointInPolygon(x, y, k.points));
}

export function checkMaterialBoard(
  pcbText: string,
  plan: MaterialApplyPlan,
  extra?: { bendZones?: RectMm[]; pedestalPads?: PedestalPad[] },
): MaterialViolation[] {
  const geo = extractBoardGeometry(pcbText);
  const zones = extra?.bendZones ?? plan.bendZones;
  const pedestals = extra?.pedestalPads ?? plan.pedestalPads;
  const violations: MaterialViolation[] = [];
  const material = plan.material;

  if (material === "flex") {
    for (const v of geo.vias) {
      if (inBend(v.x, v.y, zones, geo.keepouts)) {
        violations.push({ kind: "via_in_bend_zone", detail: `via at (${v.x.toFixed(2)}, ${v.y.toFixed(2)}) sits in a flex bend zone`, x: v.x, y: v.y, ...(v.net ? { net: v.net } : {}) });
      }
    }
    for (const p of geo.pads) {
      if (inBend(p.x, p.y, zones, geo.keepouts)) {
        violations.push({ kind: "pad_in_bend_zone", detail: `pad ${p.ref}:${p.pad} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) sits in a flex bend zone`, x: p.x, y: p.y, ref: p.ref });
      }
    }
  }

  if (material === "aluminium" || material === "copper_core") {
    for (const p of geo.pads) {
      if (p.type === "thru_hole" && plan.rules.viaPolicy !== "isolated_npth") {
        violations.push({
          kind: "pth_on_metal_core",
          detail: `plated through-hole ${p.ref}:${p.pad} is not allowed on ${material === "aluminium" ? "aluminium" : "copper-core"} without isolation`,
          x: p.x,
          y: p.y,
          ref: p.ref,
        });
      }
    }
    if (!plan.rules.allowBacksideSmd) {
      for (const fp of geo.footprints) {
        if (/^B\./.test(fp.layer)) {
          violations.push({
            kind: "backside_on_metal_core",
            detail: `${fp.ref} is on ${fp.layer}; metal-core boards are single-sided`,
            x: fp.x,
            y: fp.y,
            ref: fp.ref,
          });
        }
      }
    }
    for (const v of geo.vias) {
      if (plan.rules.viaPolicy === "none") {
        violations.push({ kind: "via_not_allowed", detail: `via at (${v.x.toFixed(2)}, ${v.y.toFixed(2)}) is not allowed on this metal-core stackup`, x: v.x, y: v.y });
      }
    }
  }

  if (material === "copper_core") {
    const powerPads = geo.pads.filter((p) => /EP|THERMAL|PAD/i.test(p.pad) || /LED|U|Q/i.test(p.ref));
    for (const p of powerPads) {
      if (p.pad === "EP" || /thermal/i.test(p.pad) || p.pedestal) {
        if (!isPedestal(p, pedestals)) {
          violations.push({
            kind: "missing_pedestal",
            detail: `thermal pad ${p.ref}:${p.pad} is not marked as a copper-core pedestal`,
            x: p.x,
            y: p.y,
            ref: p.ref,
          });
        }
      }
    }
  }

  if (material === "rogers" || material === "ptfe" || material === "fr4" || material === "hdi") {
    const target = plan.impedance.single50;
    const d = plan.stackup.find((l) => l.er !== undefined);
    const er = d?.er ?? 4.5;
    const h = d?.thicknessMm ?? 0.2;
    const t = plan.stackup.find((l) => l.kind === "copper")?.thicknessMm ?? 0.035;
    for (const tr of geo.tracks) {
      const name = tr.net ?? "";
      if (!RF_NET.test(name) && name !== "50OHM" && name !== "RF") continue;
      const expected = target.widthMm;
      const err = Math.abs(tr.width - expected) / expected;
      if (err > WIDTH_TOLERANCE) {
        const z = microstripZ0({ widthMm: tr.width, er, heightMm: h, copperMm: t });
        violations.push({
          kind: "impedance_width",
          detail: `net ${name || "RF"} is ${tr.width} mm wide (${z.toFixed(1)} Ω est.) but ${target.z0} Ω on this laminate wants ${expected} mm (Dk ${er}, h ${h} mm)`,
          x: tr.x1,
          y: tr.y1,
          net: name,
        });
      }
    }
  }

  return violations;
}

export function materialCheckTitle(id: BoardMaterialId): string {
  return `Material checks (${id})`;
}
