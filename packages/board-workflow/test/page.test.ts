import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { boardPageData, boardPageHtml, drcItems, pageLayers, svgBody } from "../src/review/page";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const layersBlock = (cu: string[]) => `(kicad_pcb (layers ${cu.map((n, i) => `(${i * 2} "${n}" signal)`).join(" ")} (25 "Edge.Cuts" user) (31 "F.CrtYd" user)))`;

describe("board page (board_page.py)", () => {
  test("pageLayers keeps the toolkit's table for an 8-layer board and the board's copper otherwise", () => {
    const eight = pageLayers(layersBlock(["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"]));
    expect(eight.map((l) => l[0])).toEqual(["Edge.Cuts", "In1.Cu", "In6.Cu", "In4.Cu", "In3.Cu", "In5.Cu", "In2.Cu", "B.Cu", "F.Cu", "B.Courtyard", "F.Courtyard", "B.Fab", "F.Fab"]);
    expect(pageLayers(layersBlock(["F.Cu", "B.Cu"])).map((l) => l[0])).toEqual(["Edge.Cuts", "B.Cu", "F.Cu", "B.Courtyard", "F.Courtyard", "B.Fab", "F.Fab"]);
    const ten = pageLayers(layersBlock(["F.Cu", "In1.Cu", "In2.Cu", "In10.Cu", "In7.Cu", "B.Cu"])).map((l) => l[0]);
    expect(ten.slice(0, 3)).toEqual(["Edge.Cuts", "In7.Cu", "In10.Cu"]);
    expect(pageLayers("(kicad_pcb)").length).toBe(13);
  });

  test("svgBody strips the header, title and desc and maps black/white", () => {
    const [vb, body] = svgBody(`<?xml?>\n<svg\n xmlns="x" viewBox="1 2 3 4">\n<title>t</title><desc>d</desc><g style="fill:#000000;stroke:#FFFFFF"/></svg>\n`);
    expect(vb).toBe("1 2 3 4");
    expect(body).toBe(`\n<g style="fill:currentColor;stroke:var(--hole)"/>`);
    expect(() => svgBody("<svg>")).toThrow(/viewBox/);
  });

  test("drcItems: opens with net and both ends, error-severity violations only, exclusions left out", () => {
    const d = drcItems({
      unconnected_items: [{ items: [{ description: "Pad 1 [SIG]  of U1", pos: { x: 1, y: 2 } }, { description: "Pad 2 [SIG] of R1", pos: { x: 3, y: 4 } }] }, { items: [{ description: "Track", pos: { x: 0, y: 0 } }] }],
      violations: [
        { type: "clearance", severity: "error", description: "x".repeat(200), items: [{ description: "", pos: { x: 5, y: 6 } }] },
        { type: "silk_overlap", severity: "warning", description: "w", items: [{ description: "", pos: { x: 0, y: 0 } }] },
        { type: "clearance", severity: "error", description: "owner excluded", excluded: true, items: [{ description: "", pos: { x: 0, y: 0 } }] },
      ],
    });
    expect(d.opens).toEqual([
      { net: "SIG", a: [1, 2], b: [3, 4], d: "Pad 1 [SIG] of U1 / Pad 2 [SIG] of R1" },
      { net: "?", a: [0, 0], b: [0, 0], d: "Track" },
    ]);
    expect(d.viol).toEqual([{ t: "clearance", p: [5, 6], d: "x".repeat(160) }]);
  });

  test("boardPageData plots each layer through kicad-cli in order, reads the DRC report and score beside the board", async () => {
    const dir = await mkdtemp(join(tmpdir(), "page-"));
    dirs.push(dir);
    await writeFile(join(dir, "b.kicad_pcb"), layersBlock(["F.Cu", "B.Cu"]));
    await writeFile(join(dir, "acceptance.drc.json"), JSON.stringify({ unconnected_items: [{ items: [{ description: "[N]", pos: { x: 1, y: 1 } }] }], violations: [] }));
    await writeFile(join(dir, "score.json"), JSON.stringify({ open: 1, summary: { A1_connectivity: false } }));
    const calls: string[][] = [];
    const kicad = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "export") await writeFile(args[args.indexOf("-o") + 1]!, `<svg viewBox="0 0 10 10"><path fill="#000000" d="M0 0"/></svg>`);
      return { exitCode: args[1] === "render" ? 1 : 0, stdout: "", stderr: args[1] === "render" ? "no GL" : "" };
    };
    const b = await boardPageData("A", dir, { kicad });
    expect(calls.filter((c) => c[1] === "export").map((c) => c[c.indexOf("-l") + 1])).toEqual(["Edge.Cuts", "B.Cu", "F.Cu", "B.Courtyard", "F.Courtyard", "B.Fab", "F.Fab"]);
    expect(calls.filter((c) => c[1] === "render").map((c) => c[c.indexOf("--side") + 1])).toEqual(["top", "bottom"]);
    expect(b.vb).toBe("0 0 10 10");
    expect(gunzipSync(Buffer.from(b.layers[0]!.z, "base64")).toString()).toBe(`<path fill="currentColor" d="M0 0"/>`);
    expect(b.opens.map((o) => o.net)).toEqual(["N"]);
    expect(b.score).toEqual({ open: 1, summary: { A1_connectivity: false } });
    expect(b.r3).toEqual({});
    expect(b.notes.join("\n")).toContain("3D render (top) failed: no GL");
    // a layer kicad-cli does not write is an error, not a blank layer
    await expect(boardPageData("A", join(dir, "b.kicad_pcb"), { kicad: async () => ({ exitCode: 0, stdout: "", stderr: "" }), no3d: true })).rejects.toThrow(/could not plot Edge.Cuts/);
  });

  test("boardPageHtml embeds escaped data and a script that parses", () => {
    const html = boardPageHtml([{ label: "<x>", path: "/p", vb: "0 0 1 1", layers: [], r3: {}, opens: [], viol: [{ t: "a", p: [0, 0], d: "</script>" }], score: {} }], "T & U");
    expect(html.startsWith('<!doctype html><meta charset="utf-8">')).toBe(true);
    expect(html).toContain("<title>T &amp; U</title>");
    expect(html).not.toContain("</script>\"");
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("const BOARDS = [{");
    expect(script).toContain("`translate(${2 * x + w} 0) scale(-1 1)`");
  });
});
