import { rotationDelta } from "./geometry";
import type { DesignPart, DesignSnapshot, FabCheckFinding, FabCheckSection, FabRules } from "./types";

export type PlacementRow = {
  ref: string;
  value: string;
  footprint: string;
  x: number;
  y: number;
  rotationDeg: number;
  side: "top" | "bottom";
};

export function checkBomPnp(opts: {
  bomCsv?: string;
  posCsv?: string;
  design?: DesignSnapshot;
  rules: FabRules;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const designParts = (opts.design?.parts ?? []).filter((p) => !p.dnp);
  const dnp = (opts.design?.parts ?? []).filter((p) => p.dnp);
  const pos = opts.posCsv ? parsePosCsv(opts.posCsv) : [];
  const bomRefs = opts.bomCsv ? parseBomRefs(opts.bomCsv) : [];

  if (!opts.posCsv)
    findings.push({
      id: "no-pos",
      check: "bom",
      severity: "warn",
      message: "No pick-and-place CSV in the package.",
    });
  if (!opts.bomCsv)
    findings.push({
      id: "no-bom",
      check: "bom",
      severity: "warn",
      message: "No BOM CSV in the package.",
    });

  const posByRef = new Map(pos.map((p) => [p.ref, p]));
  const bomSet = new Set(bomRefs);

  for (const part of designParts) {
    const row = posByRef.get(part.ref);
    if (!row) {
      findings.push({
        id: `missing-pos-${part.ref}`,
        check: "bom",
        severity: "fail",
        message: `${part.ref} is on the board but missing from pick-and-place.`,
        ref: part.ref,
        x: part.x,
        y: part.y,
      });
      continue;
    }
    if (row.value && part.value && normalize(row.value) !== normalize(part.value))
      findings.push({
        id: `value-${part.ref}`,
        check: "bom",
        severity: "warn",
        message: `${part.ref} value is ${part.value} on the board and ${row.value} in pick-and-place.`,
        ref: part.ref,
        x: part.x,
        y: part.y,
      });
    if (row.footprint && part.footprint && !footprintsMatch(row.footprint, part.footprint))
      findings.push({
        id: `fp-${part.ref}`,
        check: "bom",
        severity: "warn",
        message: `${part.ref} footprint is ${part.footprint} on the board and ${row.footprint} in pick-and-place.`,
        ref: part.ref,
      });
    if (Math.hypot(row.x - part.x, row.y - part.y) > 0.15)
      findings.push({
        id: `xy-${part.ref}`,
        check: "bom",
        severity: "fail",
        message: `${part.ref} is at ${part.x.toFixed(3)},${part.y.toFixed(3)} on the board vs ${row.x.toFixed(3)},${row.y.toFixed(3)} in pick-and-place.`,
        ref: part.ref,
        x: part.x,
        y: part.y,
      });
    const expectedRot = part.rotationDeg + opts.rules.rotationOffsetDeg;
    if (rotationDelta(row.rotationDeg, expectedRot) > 1)
      findings.push({
        id: `rot-${part.ref}`,
        check: "bom",
        severity: "fail",
        message: `${part.ref} rotation is ${part.rotationDeg}° on the board vs ${row.rotationDeg}° in pick-and-place (${opts.rules.label} offset ${opts.rules.rotationOffsetDeg}°). Polarized parts are a common export pitfall.`,
        ref: part.ref,
        x: part.x,
        y: part.y,
      });
    if (row.side !== part.side)
      findings.push({
        id: `side-${part.ref}`,
        check: "bom",
        severity: "fail",
        message: `${part.ref} is on ${part.side} on the board and ${row.side} in pick-and-place.`,
        ref: part.ref,
      });
  }

  for (const row of pos) {
    if (designParts.some((p) => p.ref === row.ref) || dnp.some((p) => p.ref === row.ref)) continue;
    findings.push({
      id: `extra-pos-${row.ref}`,
      check: "bom",
      severity: "fail",
      message: `${row.ref} is in pick-and-place but not on the exported board.`,
      ref: row.ref,
      x: row.x,
      y: row.y,
    });
  }

  for (const part of dnp) {
    if (posByRef.has(part.ref))
      findings.push({
        id: `dnp-pos-${part.ref}`,
        check: "bom",
        severity: "warn",
        message: `${part.ref} is marked DNP on the board but still appears in pick-and-place.`,
        ref: part.ref,
      });
    if (bomSet.has(part.ref))
      findings.push({
        id: `dnp-bom-${part.ref}`,
        check: "bom",
        severity: "warn",
        message: `${part.ref} is marked DNP on the board but still appears in the BOM.`,
        ref: part.ref,
      });
  }

  if (bomRefs.length && designParts.length) {
    for (const part of designParts) {
      if (!bomSet.has(part.ref))
        findings.push({
          id: `missing-bom-${part.ref}`,
          check: "bom",
          severity: "fail",
          message: `${part.ref} is on the board but missing from the BOM.`,
          ref: part.ref,
        });
    }
    for (const ref of bomRefs) {
      if (!designParts.some((p) => p.ref === ref) && !dnp.some((p) => p.ref === ref))
        findings.push({
          id: `extra-bom-${ref}`,
          check: "bom",
          severity: "warn",
          message: `${ref} is in the BOM but not on the board.`,
          ref,
        });
    }
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  const hasDesign = designParts.length > 0;
  return {
    id: "bom",
    title: "BOM and pick-and-place",
    verdict: fails ? "fail" : findings.length ? "warn" : hasDesign || pos.length ? "pass" : "skip",
    summary: fails
      ? `${fails} designator / position / rotation mismatch(es) between the board and the export.`
      : hasDesign
        ? "BOM and pick-and-place match the board, including DNP handling."
        : "No board parts were supplied to cross-check.",
    findings: findings.slice(0, 60),
  };
}

export function parsePosCsv(text: string): PlacementRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const idx = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const refI = idx(["ref", "designator", "reference", "refdes"]);
  const valI = idx(["val", "value", "comment"]);
  const fpI = idx(["package", "footprint"]);
  const xI = idx(["posx", "pos_x", "mid x", "x", "centerx"]);
  const yI = idx(["posy", "pos_y", "mid y", "y", "centery"]);
  const rotI = idx(["rot", "rotation", "angle"]);
  const sideI = idx(["side", "layer"]);
  if (refI < 0 || xI < 0 || yI < 0) return [];
  const out: PlacementRow[] = [];
  for (const row of rows.slice(1)) {
    const ref = row[refI]?.trim();
    if (!ref || ref.startsWith("#")) continue;
    const sideRaw = (row[sideI] ?? "top").toLowerCase();
    out.push({
      ref,
      value: row[valI]?.trim() ?? "",
      footprint: row[fpI]?.trim() ?? "",
      x: Number(row[xI] ?? 0),
      y: Number(row[yI] ?? 0),
      rotationDeg: Number(row[rotI] ?? 0),
      side: /bot|b\.cu/.test(sideRaw) ? "bottom" : "top",
    });
  }
  return out;
}

export function parseBomRefs(text: string): string[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const refI = header.findIndex((h) => ["reference", "designator", "refs", "ref"].includes(h));
  const i = refI >= 0 ? refI : 0;
  const refs: string[] = [];
  for (const row of rows.slice(1)) {
    const cell = row[i]?.trim() ?? "";
    if (!cell) continue;
    for (const part of cell.split(/[,;\s]+/)) {
      const ref = part.trim();
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function footprintsMatch(a: string, b: string): boolean {
  const na = a.split(":").pop() ?? a;
  const nb = b.split(":").pop() ?? b;
  return normalize(na) === normalize(nb);
}
