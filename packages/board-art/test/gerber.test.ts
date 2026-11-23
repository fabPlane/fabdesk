import { describe, expect, test } from "bun:test";
import { fillRect, makeGray } from "../src/image";
import { buildBoardArt } from "../src/job";
import { parseGerber } from "../src/gerber";
import { readZip } from "../src/zip";
import { decodePng, encodePng } from "../src/png";
import { rgbaToGray } from "../src/image";

function logo() {
  const img = makeGray(48, 48, 255);
  fillRect(img, 6, 6, 36, 8, 20);
  fillRect(img, 6, 20, 20, 8, 20);
  fillRect(img, 6, 34, 36, 8, 20);
  return img;
}

const opts = {
  widthMm: 50,
  heightMm: 40,
  color: "black" as const,
  outline: "rectangle" as const,
  minFeatureMm: 0.2,
  pitchMm: 0.9,
  marginMm: 2,
};

describe("gerber output", () => {
  test("realistic zip parses back to flashed dots", () => {
    const job = buildBoardArt(logo(), { ...opts, style: "realistic" });
    const silk = job.gerbers.find((g) => g.name.includes("Silkscreen") && g.name.startsWith("board-F"));
    expect(silk).toBeDefined();
    const parsed = parseGerber(silk!.body);
    expect(parsed.unit).toBe("mm");
    expect(parsed.polarity).toBe("dark");
    expect(parsed.apertures.every((a) => a.kind !== "C" || a.d + 1e-9 >= 0.15)).toBe(true);
    const flashes = parsed.ops.filter((op) => op.op === "flash");
    expect(flashes.length).toBe(job.art.clipped.filter((p) => p.kind === "circle").length);
    expect(flashes.length).toBeGreaterThan(10);
    expect(silk!.body).toContain("%FSLAX46Y46*%");
    expect(silk!.body.trim().endsWith("M02*")).toBe(true);
  });

  test("retro zip parses back to drawn lines", () => {
    const job = buildBoardArt(logo(), { ...opts, style: "retro" });
    const parsed = parseGerber(job.gerbers.find((g) => g.name === "board-F_Silkscreen.gbr")!.body);
    const draws = parsed.ops.filter((op) => op.op === "draw");
    expect(draws.length).toBe(job.art.clipped.filter((p) => p.kind === "line").length);
    expect(draws.length).toBeGreaterThan(3);
  });

  test("poster zip parses back to flashed rectangles", () => {
    const job = buildBoardArt(logo(), { ...opts, style: "poster", pitchMm: 1 });
    const parsed = parseGerber(job.gerbers.find((g) => g.name === "board-F_Silkscreen.gbr")!.body);
    expect(parsed.apertures.some((a) => a.kind === "R")).toBe(true);
    expect(parsed.ops.filter((op) => op.op === "flash").length).toBeGreaterThan(0);
  });

  test("edge cuts and copper layers are present and parse", () => {
    const job = buildBoardArt(logo(), { ...opts, style: "poster", layers: ["silk", "mask", "copper"], fillCopper: false });
    const names = job.gerbers.map((g) => g.name).sort();
    expect(names).toContain("board-Edge_Cuts.gbr");
    expect(names).toContain("board-F_Cu.gbr");
    expect(names).toContain("board-F_Mask.gbr");
    const edge = parseGerber(job.gerbers.find((g) => g.name === "board-Edge_Cuts.gbr")!.body);
    expect(edge.ops.filter((op) => op.op === "draw").length).toBe(4);
    expect(edge.fileFunction).toBe("Profile,NP");
    expect(edge.format).toEqual({ int: 4, frac: 6 });
    const copper = parseGerber(job.gerbers.find((g) => g.name === "board-F_Cu.gbr")!.body);
    expect(copper.ops.length).toBeGreaterThan(0);
    expect(copper.fileFunction).toBe("Copper,L1,Top");
  });

  test("parses oval apertures, FileFunction comments, and decimal coordinates", () => {
    const text = [
      "G04 #@! TF.FileFunction,Copper,L1,Top*",
      "%FSLAX36Y36*%",
      "%MOMM*%",
      "%LPD*%",
      "%ADD10C,0.2*%",
      "%ADD11O,1.2X0.6*%",
      "%ADD12P,1.0X6*%",
      "D11*",
      "X1.5Y2.0D03*",
      "D10*",
      "X0Y0D02*",
      "X3000000Y0D01*",
      "M02*",
    ].join("\n");
    const parsed = parseGerber(text);
    expect(parsed.fileFunction).toBe("Copper,L1,Top");
    expect(parsed.format).toEqual({ int: 3, frac: 6 });
    expect(parsed.apertures).toEqual([
      { id: 10, kind: "C", d: 0.2 },
      { id: 11, kind: "O", w: 1.2, h: 0.6 },
    ]);
    expect(parsed.skippedApertures).toEqual([12]);
    expect(parsed.ops).toEqual([
      { op: "flash", x: 1.5, y: 2, aperture: 11 },
      { op: "draw", x1: 0, y1: 0, x2: 3, y2: 0, aperture: 10 },
    ]);
  });

  test("fabrication zip round-trips and includes a KiCad board", () => {
    const job = buildBoardArt(logo(), { ...opts, style: "realistic" });
    const entries = readZip(job.zip);
    expect(entries.map((e) => e.name)).toContain("gerbers/board-F_Silkscreen.gbr");
    expect(entries.map((e) => e.name)).toContain("board.kicad_pcb");
    const pcb = new TextDecoder().decode(entries.find((e) => e.name === "board.kicad_pcb")!.data);
    expect(pcb).toContain("(kicad_pcb");
    expect(pcb).toContain("F.SilkS");
    expect(pcb).toContain("Edge.Cuts");
    expect(pcb).toContain("gr_circle");
    expect(job.kicadPcb).toBe(pcb);
  });
});

describe("png", () => {
  test("encode/decode round trip", () => {
    const data = new Uint8Array(4 * 2 * 2);
    data.set([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const png = encodePng({ width: 2, height: 2, data });
    const back = decodePng(png);
    expect(back.width).toBe(2);
    expect(back.height).toBe(2);
    expect([...back.data]).toEqual([...data]);
    const gray = rgbaToGray(back);
    expect(gray.pixels.length).toBe(4);
  });
});
