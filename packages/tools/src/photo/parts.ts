import type { CircuitIntent, PickedPart, PhotoSighting, SightedItem } from "@fabdesk/protocol";
import type { FootprintHit } from "../services";

export type PartSearch = (query: string, kind: "footprint" | "symbol") => Promise<FootprintHit[]>;

const DEFAULTS: Record<SightedItem["kind"], { value: string; footprint: string; symbol: string; prefix: string }> = {
  ic: { value: "MCU", footprint: "Package_DFN_QFN:QFN-32-1EP_5x5mm_P0.5mm", symbol: "Device:U", prefix: "U" },
  connector: { value: "USB-C", footprint: "Connector_USB:USB_C_Receptacle_GCT_USB4105-GF-A_TopMnt_Horizontal", symbol: "Connector:USB_C_Receptacle", prefix: "J" },
  switch: { value: "SW", footprint: "Button_Switch_SMD:SW_SPST_CK_RS282G05A3", symbol: "Switch:SW_Push", prefix: "SW" },
  led: { value: "LED", footprint: "LED_SMD:LED_0805_2012Metric", symbol: "Device:LED", prefix: "D" },
  battery: { value: "AA", footprint: "Battery:BatteryHolder_Keystone_2460_1xAA", symbol: "Device:Battery", prefix: "BT" },
  display: { value: "OLED", footprint: "Display:SSD1306-128x64_Adafruit", symbol: "Display:SSD1306", prefix: "DS" },
  encoder: { value: "ENC", footprint: "Rotary_Encoder:RotaryEncoder_Alps_EC11E-Switch_Vertical_H20mm", symbol: "Device:Rotary_Encoder_Switch", prefix: "SW" },
  passive: { value: "10k", footprint: "Resistor_SMD:R_0805_2012Metric", symbol: "Device:R", prefix: "R" },
  mounting_hole: { value: "M2", footprint: "MountingHole:MountingHole_2.2mm_M2", symbol: "Mechanical:MountingHole", prefix: "H" },
  other: { value: "PART", footprint: "Resistor_SMD:R_0805_2012Metric", symbol: "Device:R", prefix: "U" },
};

export async function pickParts(
  sighting: PhotoSighting,
  intent: CircuitIntent,
  search: PartSearch,
): Promise<PickedPart[]> {
  const counts = new Map<string, number>();
  const out: PickedPart[] = [];
  for (const item of sighting.items) {
    if (item.kind === "mounting_hole") continue;
    const fallback = DEFAULTS[item.kind];
    const n = (counts.get(fallback.prefix) ?? 0) + 1;
    counts.set(fallback.prefix, n);
    const query = item.mpn ?? item.markings ?? item.label;
    const [foot, sym] = await Promise.all([
      search(query, "footprint").catch(() => []),
      search(query, "symbol").catch(() => []),
    ]);
    const footprint = preferIdentified(foot, item) ?? fallback.footprint;
    const symbol = preferIdentified(sym, item) ?? fallback.symbol;
    const source = item.mpn || item.markings ? "marking" : foot[0] ? "search" : "default";
    out.push({
      itemId: item.id,
      ref: `${fallback.prefix}${n}`,
      value: item.mpn ?? item.markings ?? item.label ?? fallback.value,
      footprint,
      symbol,
      ...(item.mpn ? { mpn: item.mpn } : {}),
      source,
    });
  }
  void intent;
  return out;
}

function preferIdentified(hits: FootprintHit[], item: SightedItem): string | undefined {
  const needle = (item.mpn ?? item.markings ?? "").toLowerCase();
  if (needle) {
    const exact = hits.find((h) => h.libId.toLowerCase().includes(needle) || h.name.toLowerCase().includes(needle));
    if (exact) return exact.libId;
  }
  return hits[0]?.libId;
}

export function placementsFromSighting(
  sighting: PhotoSighting,
  parts: readonly PickedPart[],
): Array<{ ref: string; x: number; y: number; rotation: number; layer: "F" | "B" }> {
  const byId = new Map(parts.map((p) => [p.itemId, p]));
  const w = sighting.scale.boardWidthMm;
  const h = sighting.scale.boardHeightMm;
  const out: Array<{ ref: string; x: number; y: number; rotation: number; layer: "F" | "B" }> = [];
  for (const item of sighting.items) {
    const part = byId.get(item.id);
    if (!part) continue;
    const cx = (item.box.x + item.box.w / 2) * w;
    const cy = (item.box.y + item.box.h / 2) * h;
    out.push({
      ref: part.ref,
      x: round2(cx),
      y: round2(cy),
      rotation: item.rotationDeg ?? 0,
      layer: item.side === "back" ? "B" : "F",
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
