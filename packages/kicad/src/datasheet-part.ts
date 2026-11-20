/**
 * Datasheet / part-number → KiCad symbol + footprint.
 *
 * The in-KiCad picker calls this when search is empty. It maps an MPN or
 * datasheet URL onto a KiCad-standard Device template (with Footprint, MPN
 * and Manufacturer filled in) so the result is pasteable without an LLM.
 */

import {
  buildSchematicClipboard,
  fallbackSymbolSexpr,
  splitLibId,
  type ClipboardPart,
} from "./clipboard";

export type DatasheetPartInput = {
  mpn?: string;
  datasheetUrl?: string;
  manufacturer?: string;
  value?: string;
};

export type MadeCadPart = {
  name: string;
  value: string;
  footprint: string;
  symbolLibId: string;
  reference: string;
  description: string;
  symbolSexpr: string;
  paste: string;
  pinNumbers: string[];
  mpn?: string;
  manufacturer?: string;
  datasheet?: string;
};

type Kind = "resistor" | "capacitor" | "inductor" | "led" | "diode" | "ic";

const PACKAGE_FOOTPRINTS: Array<{ re: RegExp; footprint: string }> = [
  { re: /0402|1005metric/i, footprint: "Resistor_SMD:R_0402_1005Metric" },
  { re: /0603|1608metric/i, footprint: "Resistor_SMD:R_0603_1608Metric" },
  { re: /0805|2012metric/i, footprint: "Resistor_SMD:R_0805_2012Metric" },
  { re: /1206|3216metric/i, footprint: "Resistor_SMD:R_1206_3216Metric" },
  { re: /sot[-_]?23-?6/i, footprint: "Package_TO_SOT_SMD:SOT-23-6" },
  { re: /sot[-_]?23/i, footprint: "Package_TO_SOT_SMD:SOT-23" },
  { re: /sod[-_]?123/i, footprint: "Diode_SMD:D_SOD-123" },
  { re: /soic[-_]?8|so[-_]?8/i, footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" },
  { re: /soic[-_]?14/i, footprint: "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm" },
  { re: /qfn[-_]?16/i, footprint: "Package_DFN_QFN:QFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm" },
  { re: /qfn[-_]?24/i, footprint: "Package_DFN_QFN:QFN-24-1EP_4x4mm_P0.5mm_EP2.6x2.6mm" },
  { re: /lqfp[-_]?48/i, footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm" },
  { re: /lqfp[-_]?64/i, footprint: "Package_QFP:LQFP-64_10x10mm_P0.5mm" },
];

const CAP_FOOTPRINTS: Record<string, string> = {
  "Resistor_SMD:R_0402_1005Metric": "Capacitor_SMD:C_0402_1005Metric",
  "Resistor_SMD:R_0603_1608Metric": "Capacitor_SMD:C_0603_1608Metric",
  "Resistor_SMD:R_0805_2012Metric": "Capacitor_SMD:C_0805_2012Metric",
  "Resistor_SMD:R_1206_3216Metric": "Capacitor_SMD:C_1206_3216Metric",
};

function inferKind(text: string): Kind {
  if (/\b(led|ltst|wp[0-9]|sml-)/i.test(text)) return "led";
  if (/\b(1n4148|1n400[1-7]|bat54|schottky|diode)\b/i.test(text)) return "diode";
  if (/^(grm|cl\d)|c0g|x5r|x7r|capacitor|\bcap\b/i.test(text)) return "capacitor";
  if (/\b(inductor|\bind\b|lqm|nlcv)/i.test(text)) return "inductor";
  if (/^(rc|ac|erj|crcw)|resistor|\bres\b|ohm|kω|mω/i.test(text)) return "resistor";
  if (/\b(stm32|atmega|esp32|nrf52|tps|lm\d|opamp|mcu|\bic\b)/i.test(text)) return "ic";
  if (/(0402|0603|0805|1206)/.test(text) && /r[cjl]/i.test(text)) return "resistor";
  return "ic";
}

function inferFootprint(kind: Kind, text: string): string {
  for (const row of PACKAGE_FOOTPRINTS) {
    if (!row.re.test(text)) continue;
    if (kind === "capacitor") return CAP_FOOTPRINTS[row.footprint] ?? "Capacitor_SMD:C_0402_1005Metric";
    if (kind === "led") return "LED_SMD:LED_0402_1005Metric";
    if (kind === "diode" && /sod|sma|smb/i.test(text)) return row.footprint;
    if (kind === "resistor" || kind === "inductor") return row.footprint;
    if (kind === "ic") return row.footprint;
    return row.footprint;
  }
  switch (kind) {
    case "capacitor":
      return "Capacitor_SMD:C_0402_1005Metric";
    case "led":
      return "LED_SMD:LED_0402_1005Metric";
    case "diode":
      return "Diode_SMD:D_SOD-123";
    case "inductor":
      return "Inductor_SMD:L_0402_1005Metric";
    case "ic":
      if (/stm32/i.test(text)) {
        if (/64|lqfp[-_]?64|[rt][8b]/i.test(text)) return "Package_QFP:LQFP-64_10x10mm_P0.5mm";
        return "Package_QFP:LQFP-48_7x7mm_P0.5mm";
      }
      return "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm";
    default:
      return "Resistor_SMD:R_0402_1005Metric";
  }
}

function kindMeta(
  kind: Kind,
): { libId: string; reference: string; pinNumbers: string[]; description: string } {
  switch (kind) {
    case "resistor":
      return { libId: "Device:R", reference: "R", pinNumbers: ["1", "2"], description: "Resistor" };
    case "capacitor":
      return {
        libId: "Device:C",
        reference: "C",
        pinNumbers: ["1", "2"],
        description: "Unpolarized capacitor",
      };
    case "inductor":
      return { libId: "Device:L", reference: "L", pinNumbers: ["1", "2"], description: "Inductor" };
    case "led":
      return {
        libId: "Device:LED",
        reference: "D",
        pinNumbers: ["1", "2"],
        description: "Light emitting diode",
      };
    case "diode":
      return { libId: "Device:D", reference: "D", pinNumbers: ["1", "2"], description: "Diode" };
    default:
      return {
        libId: "Device:U",
        reference: "U",
        pinNumbers: ["1", "2", "3", "4", "5", "6", "7", "8"],
        description: "Integrated circuit",
      };
  }
}

function nameFrom(input: DatasheetPartInput): string {
  const mpn = input.mpn?.trim();
  if (mpn) return mpn;
  const url = input.datasheetUrl?.trim();
  if (url) {
    try {
      const path = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "part";
      return path.replace(/\.(pdf|html?)$/i, "") || "part";
    } catch {
      return "part";
    }
  }
  throw new Error("mpn or datasheetUrl is required");
}

function manufacturerFrom(input: DatasheetPartInput, name: string): string | undefined {
  if (input.manufacturer?.trim()) return input.manufacturer.trim();
  if (/^(rc|ac|rt)/i.test(name)) return "Yageo";
  if (/^grm/i.test(name)) return "Murata";
  if (/^cl\d/i.test(name)) return "Samsung";
  if (/^erj/i.test(name)) return "Panasonic";
  if (/^stm32/i.test(name)) return "STMicroelectronics";
  if (/^esp32/i.test(name)) return "Espressif";
  return undefined;
}

/** Map a part number or datasheet URL onto a pasteable KiCad CAD part. */
export function makePartFromDatasheet(input: DatasheetPartInput): MadeCadPart {
  const name = nameFrom(input);
  const blob = [name, input.value, input.manufacturer, input.datasheetUrl].filter(Boolean).join(" ");
  const kind = inferKind(blob);
  const meta = kindMeta(kind);
  const footprint = inferFootprint(kind, blob);
  const value = input.value?.trim() || name;
  const manufacturer = manufacturerFrom(input, name);
  const lib = splitLibId(`fabplane:${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  const symbolLibId = `${lib.nickname}:${lib.entry}`;
  const part: ClipboardPart = {
    libId: symbolLibId,
    reference: meta.reference,
    value,
    footprint,
    pinNumbers: meta.pinNumbers,
    ...(input.mpn?.trim() ? { mpn: input.mpn.trim() } : { mpn: name }),
    ...(manufacturer ? { manufacturer } : {}),
    ...(input.datasheetUrl?.trim() ? { datasheet: input.datasheetUrl.trim() } : {}),
    description: `${meta.description} (${name})`,
  };
  const symbolSexpr = fallbackSymbolSexpr(part);
  const paste = buildSchematicClipboard({ ...part, symbolSexpr });
  return {
    name,
    value,
    footprint,
    symbolLibId,
    reference: meta.reference,
    description: part.description ?? meta.description,
    symbolSexpr,
    paste,
    pinNumbers: meta.pinNumbers,
    ...(part.mpn ? { mpn: part.mpn } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(part.datasheet ? { datasheet: part.datasheet } : {}),
  };
}
