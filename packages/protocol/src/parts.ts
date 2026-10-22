/**
 * Off-board / mechanical / accessory parts that belong to a fabPlane project but are not placed
 * on the PCB. Robotics and mechatronics builds keep motors, displays, standoffs and screws here
 * so the project BOM stays one list. The electrical netlist (`circuit.netlist.json`) is unchanged.
 */
import { z } from "zod/v4";
import type { NetlistComponent } from "./fp-pcb";

export const PROJECT_PARTS_FILE = "project.parts.json";

export const OFFBOARD_KINDS = [
  "motor",
  "display",
  "standoff",
  "fastener",
  "enclosure",
  "accessory",
] as const;
export type OffboardKind = (typeof OFFBOARD_KINDS)[number];
export const OffboardKind = z.enum(OFFBOARD_KINDS);

export const OFFBOARD_KIND_LABELS: Record<OffboardKind, string> = {
  motor: "Motor",
  display: "Display",
  standoff: "Standoff",
  fastener: "Fastener",
  enclosure: "Enclosure",
  accessory: "Accessory",
};

/** Reference prefixes assigned when a line has no explicit ref. */
export const OFFBOARD_REF_PREFIX: Record<OffboardKind, string> = {
  motor: "M",
  display: "DS",
  standoff: "ST",
  fastener: "H",
  enclosure: "ENC",
  accessory: "A",
};

export const OffboardCatalogPart = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: OffboardKind,
  description: z.string(),
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  specs: z.record(z.string(), z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});
export type OffboardCatalogPart = z.infer<typeof OffboardCatalogPart>;

export const ProjectPartLine = z.object({
  id: z.string().min(1),
  catalogId: z.string().optional(),
  ref: z.string().min(1),
  name: z.string().min(1),
  kind: OffboardKind,
  qty: z.number().int().positive(),
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  notes: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ProjectPartLine = z.infer<typeof ProjectPartLine>;

export const ProjectPartsFile = z.object({
  schema: z.literal(1),
  parts: z.array(ProjectPartLine),
});
export type ProjectPartsFile = z.infer<typeof ProjectPartsFile>;

export const emptyProjectParts = (): ProjectPartsFile => ({ schema: 1, parts: [] });

/**
 * First-party seed library. Enough for a robotics controller project to name the hardware that
 * sits next to the board — not a distributor catalog.
 */
export const OFFBOARD_CATALOG: readonly OffboardCatalogPart[] = [
  {
    id: "nema-17-stepper",
    name: "NEMA 17 stepper motor",
    kind: "motor",
    description: "1.8° bipolar stepper, 42 mm face. Typical robotics axis motor.",
    mpn: "17HS4401",
    manufacturer: "Generic",
    specs: { frame: "NEMA 17", stepAngle: "1.8°", currentA: "1.7" },
    aliases: ["nema17", "stepper", "42mm stepper"],
  },
  {
    id: "nema-23-stepper",
    name: "NEMA 23 stepper motor",
    kind: "motor",
    description: "Larger 1.8° bipolar stepper for heavier axes.",
    mpn: "23HS6620",
    manufacturer: "Generic",
    specs: { frame: "NEMA 23", stepAngle: "1.8°" },
    aliases: ["nema23", "stepper"],
  },
  {
    id: "sg90-servo",
    name: "SG90 micro servo",
    kind: "motor",
    description: "9 g analog hobby servo, 4.8–6 V.",
    mpn: "SG90",
    manufacturer: "Tower Pro",
    specs: { voltage: "4.8-6V", torqueKgCm: "1.8" },
    aliases: ["servo", "hobby servo", "9g"],
  },
  {
    id: "dc-gearmotor-12v",
    name: "12 V DC gearmotor",
    kind: "motor",
    description: "Brushed DC gearmotor for simple drivetrains.",
    specs: { voltage: "12V" },
    aliases: ["dc motor", "gearmotor"],
  },
  {
    id: "ssd1306-oled-128x64",
    name: "0.96 in OLED display (SSD1306)",
    kind: "display",
    description: "128×64 monochrome OLED, I²C. Common robotics status screen.",
    mpn: "SSD1306-128x64",
    manufacturer: "Generic",
    specs: { interface: "I2C", pixels: "128x64", sizeIn: "0.96" },
    aliases: ["oled", "ssd1306", "screen", "display"],
  },
  {
    id: "hd44780-16x2",
    name: "16×2 character LCD (HD44780)",
    kind: "display",
    description: "Alphanumeric LCD module, typically I²C backpack or parallel.",
    mpn: "LCD1602",
    manufacturer: "Generic",
    specs: { columns: "16", rows: "2" },
    aliases: ["lcd", "1602", "character display"],
  },
  {
    id: "ili9341-tft-28",
    name: "2.8 in TFT display (ILI9341)",
    kind: "display",
    description: "Color TFT, SPI, 240×320.",
    mpn: "ILI9341-2.8",
    manufacturer: "Generic",
    specs: { interface: "SPI", pixels: "240x320", sizeIn: "2.8" },
    aliases: ["tft", "ili9341", "color display"],
  },
  {
    id: "m3-standoff-hex-12",
    name: "M3 hex standoff 12 mm",
    kind: "standoff",
    description: "Brass or nylon hex standoff for board stacking.",
    specs: { thread: "M3", lengthMm: "12" },
    aliases: ["standoff", "spacer", "m3"],
  },
  {
    id: "m25-standoff-hex-10",
    name: "M2.5 hex standoff 10 mm",
    kind: "standoff",
    description: "Shorter hex standoff for compact stacks.",
    specs: { thread: "M2.5", lengthMm: "10" },
    aliases: ["standoff", "spacer", "m2.5"],
  },
  {
    id: "m3-screw-ph-8",
    name: "M3 Phillips screw 8 mm",
    kind: "fastener",
    description: "Machine screw for M3 standoffs and mounts.",
    specs: { thread: "M3", lengthMm: "8", drive: "Phillips" },
    aliases: ["screw", "bolt", "m3"],
  },
  {
    id: "m2-screw-ph-6",
    name: "M2 Phillips screw 6 mm",
    kind: "fastener",
    description: "Small machine screw for displays and brackets.",
    specs: { thread: "M2", lengthMm: "6", drive: "Phillips" },
    aliases: ["screw", "m2"],
  },
  {
    id: "m3-hex-nut",
    name: "M3 hex nut",
    kind: "fastener",
    description: "Hex nut for M3 screws and standoffs.",
    specs: { thread: "M3" },
    aliases: ["nut", "m3"],
  },
  {
    id: "m3-washer",
    name: "M3 washer",
    kind: "fastener",
    description: "Flat washer for M3 hardware.",
    specs: { thread: "M3" },
    aliases: ["washer", "m3"],
  },
  {
    id: "fan-40mm-12v",
    name: "40 mm 12 V DC fan",
    kind: "accessory",
    description: "Square axial fan for enclosure cooling.",
    specs: { sizeMm: "40", voltage: "12V" },
    aliases: ["fan", "cooling"],
  },
  {
    id: "18650-holder",
    name: "18650 battery holder",
    kind: "accessory",
    description: "Single-cell 18650 holder with spring contacts.",
    specs: { cell: "18650" },
    aliases: ["battery", "18650", "cell holder"],
  },
];

export function findOffboardCatalogPart(id: string): OffboardCatalogPart | undefined {
  return OFFBOARD_CATALOG.find((p) => p.id === id);
}

const haystack = (p: OffboardCatalogPart): string =>
  [p.id, p.name, p.kind, p.description, p.mpn, p.manufacturer, ...(p.aliases ?? []), ...Object.values(p.specs ?? {})]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();

/** Case-insensitive substring search over the seed catalog. Empty query lists the kind (or all). */
export function searchOffboardCatalog(
  query: string,
  opts: { kind?: OffboardKind; limit?: number } = {},
): OffboardCatalogPart[] {
  const q = query.trim().toLowerCase();
  const limit = opts.limit ?? 20;
  const pool = opts.kind ? OFFBOARD_CATALOG.filter((p) => p.kind === opts.kind) : OFFBOARD_CATALOG;
  const hits = q ? pool.filter((p) => haystack(p).includes(q)) : [...pool];
  return hits.slice(0, limit);
}

export function nextOffboardRef(kind: OffboardKind, used: Iterable<string>): string {
  const prefix = OFFBOARD_REF_PREFIX[kind];
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export type ProjectBomSource = "pcb" | "offboard";

export type ProjectBomLine = {
  source: ProjectBomSource;
  kind: "pcb" | OffboardKind;
  refs: string[];
  name: string;
  qty: number;
  footprint?: string;
  mpn?: string;
  manufacturer?: string;
  notes?: string;
  lineId?: string;
  catalogId?: string;
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const naturalCompare = (a: string, b: string): number => collator.compare(a, b);
const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

const MPN_KEYS = ["mpn", "manufacturer part number", "manufacturer_part_number", "mfr part", "part number"];
const MANUFACTURER_KEYS = ["manufacturer", "mfr", "manufacturer name"];
const TRUTHY = new Set(["1", "true", "yes", "y", "x", "dnp"]);
const FALSY = new Set(["0", "false", "no", "n"]);

function fieldValue(fields: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!fields) return undefined;
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(fields)) {
    if (!wanted.has(k.trim().toLowerCase())) continue;
    const t = v.trim();
    if (t && t !== "~") return t;
  }
  return undefined;
}

function excludedFromBom(c: NetlistComponent): boolean {
  if (c.ref.startsWith("#")) return true;
  const dnp = fieldValue(c.fields, "dnp", "exclude_from_bom", "exclude from bom");
  if (dnp !== undefined && TRUTHY.has(dnp.toLowerCase())) return true;
  const inBom = fieldValue(c.fields, "in_bom");
  return inBom !== undefined && FALSY.has(inBom.toLowerCase());
}

/** Grouped electrical lines plus each off-board line. PCB first by reference, then off-board in saved insertion order. */
export function projectBomLines(
  components: readonly NetlistComponent[] | null | undefined,
  parts: readonly ProjectPartLine[] | null | undefined,
): ProjectBomLine[] {
  const groups = new Map<string, { c: NetlistComponent; refs: string[] }>();
  for (const c of components ?? []) {
    if (excludedFromBom(c)) continue;
    const mpn = fieldValue(c.fields, ...MPN_KEYS);
    const manufacturer = fieldValue(c.fields, ...MANUFACTURER_KEYS);
    const key = [norm(c.value), norm(c.footprint), norm(mpn), norm(manufacturer)].join("\u0000");
    const g = groups.get(key);
    if (g) g.refs.push(c.ref);
    else groups.set(key, { c, refs: [c.ref] });
  }
  const pcb: ProjectBomLine[] = [...groups.values()].map(({ c, refs }) => {
    const sorted = [...new Set(refs)].sort(naturalCompare);
    const mpn = fieldValue(c.fields, ...MPN_KEYS);
    const manufacturer = fieldValue(c.fields, ...MANUFACTURER_KEYS);
    const notes = fieldValue(c.fields, "description");
    return {
      source: "pcb",
      kind: "pcb",
      refs: sorted,
      name: c.value.trim() || c.ref,
      qty: sorted.length,
      ...(c.footprint.trim() ? { footprint: c.footprint.trim() } : {}),
      ...(mpn ? { mpn } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(notes ? { notes } : {}),
    };
  });
  pcb.sort((a, b) => naturalCompare(a.refs[0] ?? "", b.refs[0] ?? ""));

  const offboard: ProjectBomLine[] = [...(parts ?? [])]
    .map((p) => ({
      source: "offboard" as const,
      kind: p.kind,
      refs: [p.ref],
      name: p.name,
      qty: p.qty,
      footprint: `offboard:${p.catalogId ?? p.kind}`,
      ...(p.mpn ? { mpn: p.mpn } : {}),
      ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      lineId: p.id,
      ...(p.catalogId ? { catalogId: p.catalogId } : {}),
    }));

  return [...pcb, ...offboard];
}

export function projectBomCsv(lines: readonly ProjectBomLine[]): string {
  const cols = ["Kind", "Source", "Reference", "Value", "Quantity", "Footprint", "MPN", "Manufacturer", "Notes"];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [cols.join(",")];
  for (const line of lines) {
    rows.push(
      [
        line.kind,
        line.source,
        line.refs.join(" "),
        line.name,
        String(line.qty),
        line.footprint ?? "",
        line.mpn ?? "",
        line.manufacturer ?? "",
        line.notes ?? "",
      ]
        .map(q)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
