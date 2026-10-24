/**
 * Merge ISO-10303-21 STEP files into one DATA section by remapping entity ids.
 * Used when no live kernel can fuse the parts (tests, missing SMLib/FreeCAD).
 * The result is a single AP214 exchange file every CAM/CAD tool can open as one model.
 */
const STEP_BEGIN = "ISO-10303-21;";

export function isStepText(text: string): boolean {
  return text.includes(STEP_BEGIN) && /DATA\s*;/i.test(text);
}

export function extractStepData(text: string): string {
  const m = text.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/i);
  if (!m?.[1]) throw new Error("STEP file has no DATA section");
  return m[1];
}

/** Highest `#N` entity id in a STEP DATA section. */
export function maxStepEntityId(data: string): number {
  let max = 0;
  for (const m of data.matchAll(/#(\d+)\s*=/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** Shift every `#N` (definitions and references) by `offset`. Leaves quoted strings alone. */
export function remapStepEntityIds(data: string, offset: number): string {
  if (offset === 0) return data;
  let out = "";
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (c === "'") {
      const end = data.indexOf("'", i + 1);
      if (end < 0) {
        out += data.slice(i);
        break;
      }
      out += data.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      while (j < data.length && data[j]! >= "0" && data[j]! <= "9") j++;
      if (j > i + 1) {
        out += `#${Number(data.slice(i + 1, j)) + offset}`;
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const CARTESIAN_POINT_RE =
  /CARTESIAN_POINT\s*\(\s*('(?:''|[^'])*'|[^,()]*)\s*,\s*\(([^)]*)\)\s*\)/gi;

function formatStepCoord(n: number): string {
  if (Object.is(n, -0)) return "0.";
  const s = String(n);
  return s.includes(".") ? s : `${s}.`;
}

/** Shift every CARTESIAN_POINT coordinate tuple in a STEP DATA section by offset (mm). */
export function translateStepData(
  data: string,
  offset: { xMm: number; yMm: number; zMm: number },
): string {
  const { xMm, yMm, zMm } = offset;
  if (xMm === 0 && yMm === 0 && zMm === 0) return data;
  return data.replace(CARTESIAN_POINT_RE, (_whole, label: string, coords: string) => {
    const parts = coords.split(",").map((s) => s.trim());
    const nums = parts.map((p) => Number.parseFloat(p));
    if (nums.length < 2 || nums.some((n) => Number.isNaN(n))) return _whole;
    const x = nums[0]! + xMm;
    const y = nums[1]! + yMm;
    if (nums.length >= 3 && parts.length >= 3) {
      const z = nums[2]! + zMm;
      return `CARTESIAN_POINT(${label},(${formatStepCoord(x)},${formatStepCoord(y)},${formatStepCoord(z)}))`;
    }
    return `CARTESIAN_POINT(${label},(${formatStepCoord(x)},${formatStepCoord(y)}))`;
  });
}

export function combineStepTexts(
  parts: Array<{ id: string; text: string; xMm?: number; yMm?: number; zMm?: number }>,
  opts: { name?: string } = {},
): string {
  if (parts.length === 0) throw new Error("combineStepTexts needs at least one part");
  const name = opts.name ?? "assembly";
  const now = new Date().toISOString().replace(/\.\d+Z$/, "");
  const chunks: string[] = [];
  let offset = 0;
  for (const part of parts) {
    if (!isStepText(part.text)) throw new Error(`not a STEP file: ${part.id}`);
    const dx = part.xMm ?? 0;
    const dy = part.yMm ?? 0;
    const dz = part.zMm ?? 0;
    let data = extractStepData(part.text);
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      data = translateStepData(data, { xMm: dx, yMm: dy, zMm: dz });
    }
    const remapped = remapStepEntityIds(data, offset);
    const place = dx !== 0 || dy !== 0 || dz !== 0 ? ` @ ${dx},${dy},${dz} mm` : "";
    chunks.push(`/* part ${part.id}${place} */\n${remapped.trim()}\n`);
    offset += maxStepEntityId(remapped);
  }
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('fabPlane kernel-agnostic assembly'),'2;1');",
    `FILE_NAME('${name}.step','${now}',('fabPlane'),('fabPlane'),'fabPlane CAD kernels','fabPlane','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    "ENDSEC;",
    "DATA;",
    chunks.join("\n"),
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
