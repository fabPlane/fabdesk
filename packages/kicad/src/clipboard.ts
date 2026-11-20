/**
 * Build a KiCad schematic clipboard payload: a self-contained `kicad_sch` snippet
 * with `lib_symbols` plus one symbol instance. Paste into the Schematic Editor
 * without copying library files onto the project.
 */

export type ClipboardFields = {
  reference: string;
  value: string;
  footprint: string;
  mpn?: string;
  manufacturer?: string;
  datasheet?: string;
  description?: string;
};

export type ClipboardPart = ClipboardFields & {
  /** Library id as shown in KiCad, e.g. `Device:R` or `fabplane:RC0402FR-0710KL`. */
  libId: string;
  /**
   * Full `(symbol "…" …)` s-expression. When omitted, a minimal box with the
   * instance fields is emitted so paste still works.
   */
  symbolSexpr?: string;
  pinNumbers?: string[];
};

const SCH_VERSION = "20231120";

export function escapeSexpr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function quote(value: string): string {
  return `"${escapeSexpr(value)}"`;
}

/** Rename the top-level `(symbol "…")` so `lib_symbols` matches the instance `lib_id`. */
export function renameSymbolSexpr(symbolSexpr: string, libId: string): string {
  return symbolSexpr.replace(/^\(\s*symbol\s+"[^"]+"/, `(symbol ${quote(libId)}`);
}

export function splitLibId(libId: string): { nickname: string; entry: string } {
  const idx = libId.indexOf(":");
  if (idx <= 0) return { nickname: "fabplane", entry: libId || "Part" };
  return { nickname: libId.slice(0, idx), entry: libId.slice(idx + 1) || "Part" };
}

export function propertyBlock(name: string, value: string, hide: boolean, at = "0 0 0"): string {
  const effects = hide
    ? `(effects (font (size 1.27 1.27)) (hide yes))`
    : `(effects (font (size 1.27 1.27)))`;
  return `(property ${quote(name)} ${quote(value)}\n    (at ${at})\n    ${effects}\n  )`;
}

function pinBlocks(numbers: string[]): string {
  return numbers
    .map((n, i) => {
      const uuid = pinUuid(n, i);
      return `  (pin ${quote(n)} (uuid ${quote(uuid)}))`;
    })
    .join("\n");
}

function pinUuid(number: string, index: number): string {
  const seed = `${number}:${index}`;
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, "0");
  return `00000000-0000-4000-8000-${hex}${index.toString(16).padStart(4, "0")}`.slice(0, 36);
}

/** Rewrite the library symbol's Footprint / Description / Datasheet properties when present. */
export function applyLibraryFields(symbolSexpr: string, fields: ClipboardFields): string {
  const set = (body: string, name: string, value: string) => {
    const re = new RegExp(`(\\(\\s*property\\s+"${name}"\\s+")([^"]*)(")`);
    return re.test(body) ? body.replace(re, `$1${escapeSexpr(value)}$3`) : body;
  };
  let out = symbolSexpr;
  out = set(out, "Value", fields.value);
  out = set(out, "Footprint", fields.footprint);
  if (fields.datasheet) out = set(out, "Datasheet", fields.datasheet);
  if (fields.description) out = set(out, "Description", fields.description);
  return out;
}

export function fallbackSymbolSexpr(part: ClipboardPart): string {
  const { entry } = splitLibId(part.libId);
  const pins = part.pinNumbers?.length ? part.pinNumbers : ["1", "2"];
  const pinDefs = pins
    .map((n, i) => {
      const y = (2.54 * (pins.length - 1)) / 2 - i * 2.54;
      return `    (pin passive line (at -5.08 ${y.toFixed(2)} 0) (length 2.54)\n      (name "~" (effects (font (size 1.27 1.27))))\n      (number ${quote(n)} (effects (font (size 1.27 1.27))))\n    )`;
    })
    .join("\n");
  const h = Math.max(2.54, ((pins.length - 1) * 2.54) / 2 + 1.27);
  return `(symbol ${quote(part.libId)}
  (exclude_from_sim no)
  (in_bom yes)
  (on_board yes)
  ${propertyBlock("Reference", part.reference, false, "0 5.08 0")}
  ${propertyBlock("Value", part.value, false, "0 -5.08 0")}
  ${propertyBlock("Footprint", part.footprint, true)}
  ${propertyBlock("Datasheet", part.datasheet ?? "~", true)}
  ${propertyBlock("Description", part.description ?? part.value, true)}
  (symbol ${quote(`${entry}_0_1`)}
    (rectangle (start -2.54 ${h.toFixed(2)}) (end 2.54 ${(-h).toFixed(2)})
      (stroke (width 0.254) (type default))
      (fill (type background))
    )
  )
  (symbol ${quote(`${entry}_1_1`)}
${pinDefs}
  )
)`;
}

function instanceProperties(part: ClipboardPart): string {
  const extras = [
    part.mpn ? propertyBlock("MPN", part.mpn, true) : "",
    part.manufacturer ? propertyBlock("Manufacturer", part.manufacturer, true) : "",
  ].filter(Boolean);
  return [
    propertyBlock("Reference", part.reference, false, "5.08 5.08 0"),
    propertyBlock("Value", part.value, false, "5.08 2.54 0"),
    propertyBlock("Footprint", part.footprint, true),
    propertyBlock("Datasheet", part.datasheet ?? "~", true),
    propertyBlock("Description", part.description ?? "", true),
    ...extras,
  ].join("\n  ");
}

/**
 * KiCad 8/9 schematic clipboard text. Selecting Paste in the Schematic Editor
 * drops one symbol with Footprint, MPN and Manufacturer fields set.
 */
export function buildSchematicClipboard(part: ClipboardPart, uuid = crypto.randomUUID()): string {
  const lib = splitLibId(part.libId);
  const libId = `${lib.nickname}:${lib.entry}`;
  const pins = part.pinNumbers?.length ? part.pinNumbers : ["1", "2"];
  const symbol =
    part.symbolSexpr && part.symbolSexpr.includes("(symbol")
      ? renameSymbolSexpr(applyLibraryFields(part.symbolSexpr.trim(), part), libId)
      : fallbackSymbolSexpr({ ...part, libId });
  return `(kicad_sch
  (version ${SCH_VERSION})
  (generator "fabplane_parts_picker")
  (generator_version "1.0")
  (uuid ${quote(uuid)})
  (paper "A4")
  (lib_symbols
    ${symbol}
  )
  (symbol
    (lib_id ${quote(libId)})
    (at 0 0 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid ${quote(uuid)})
    ${instanceProperties({ ...part, libId })}
${pinBlocks(pins)}
    (instances
      (project ""
        (path "/"
          (reference ${quote(part.reference)})
          (unit 1)
        )
      )
    )
  )
)
`;
}

export function clipboardLooksPasteable(text: string): boolean {
  return (
    text.includes("(kicad_sch") &&
    text.includes("(lib_symbols") &&
    text.includes("(lib_id") &&
    text.includes('(property "Footprint"')
  );
}
