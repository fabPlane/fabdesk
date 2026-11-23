/** The toolkit's `pcb upgrade` (tools/boardformat.py), ported: a pre-10 board upgraded on a copy, checked item by item. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyNetRefs, parseBoard } from "../src/board";
import { nameBoardNets, netDifferences, upgradeCopy } from "../src/upgrade";
import { LEGACY_BOARD } from "./fixtures";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "upgrade-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** What `kicad-cli pcb upgrade` does to the net references (names them, drops the zone's net_name, bumps the version). */
const fakeKicad = (mutate: (t: string) => string = (t) => t) => async (file: string) => {
  const t = nameBoardNets(await readFile(file, "utf8")).text.replace("(version 20241229)", "(version 20260206)");
  await writeFile(file, mutate(t));
};

describe("upgrade (pcb upgrade)", () => {
  test("the fixture is a pre-10 board: its segment, via and zone name their net by number", () => {
    expect(legacyNetRefs(LEGACY_BOARD)).toBe(3);
  });
  test("nameBoardNets names every copper item's net from the net table and changes nothing else", () => {
    const r = nameBoardNets(LEGACY_BOARD);
    expect(r.renamed).toBe(3);
    expect(legacyNetRefs(r.text)).toBe(0);
    expect(netDifferences(LEGACY_BOARD, r.text)).toEqual([]);
    expect(r.text).toContain('(zone\n\t\t(net "A")\n\t\t(layer "B.Cu")');
    expect(parseBoard(r.text).vias[0]!.net).toBe("B");
    // the zone's net_name line goes; every other line is as saved or only had its net reference named
    const was = LEGACY_BOARD.split("\n").filter((l) => !l.includes("(net_name"));
    const now = r.text.split("\n");
    expect(now.length).toBe(was.length);
    expect(now.filter((l, i) => l !== was[i]).map((l) => l.trim())).toEqual(['(net "A")', '(net "B")', '(net "A")']);
  });
  test("KiCad's upgrade is kept when every pad, track, via and zone keeps its net; the original is untouched", async () => {
    const dir = await tmp();
    const src = join(dir, "board.kicad_pcb");
    await writeFile(src, LEGACY_BOARD);
    const r = await upgradeCopy(src, join(dir, "up"), { kicad: fakeKicad() });
    expect(r.method).toBe("kicad");
    expect([r.versionBefore, r.versionAfter, r.legacyBefore, r.legacyAfter]).toEqual([20241229, 20260206, 3, 0]);
    expect(r.changed[0]).toContain("version 20241229 -> 20260206");
    expect(r.board).toBe(join(dir, "up", "board.kicad_pcb"));
    expect(await readFile(src, "utf8")).toBe(LEGACY_BOARD);
  });
  test("when KiCad would change an item's net, the copy is named in place instead and the change is reported", async () => {
    const dir = await tmp();
    const src = join(dir, "board.kicad_pcb");
    await writeFile(src, LEGACY_BOARD);
    // KiCad re-derives a via's net from the track it sits on
    const r = await upgradeCopy(src, join(dir, "up"), { kicad: fakeKicad((t) => t.replace(/(\(via[\s\S]*?)\(net "B"\)/, '$1(net "A")')) });
    expect(r.method).toBe("names");
    expect(r.kicadChanges).toEqual(["via @ 25,15: B -> A"]);
    expect(r.changed.join("\n")).toContain("KiCad's own upgrade would have changed 1 item net(s)");
    const copy = await readFile(r.board, "utf8");
    expect(legacyNetRefs(copy)).toBe(0);
    expect(netDifferences(LEGACY_BOARD, copy)).toEqual([]);
  });
  test("without KiCad the text rewrite is used; a current board is copied as it is", async () => {
    const dir = await tmp();
    const src = join(dir, "board.kicad_pcb");
    await writeFile(src, LEGACY_BOARD);
    expect((await upgradeCopy(src, join(dir, "a"))).method).toBe("names");
    await writeFile(src, nameBoardNets(LEGACY_BOARD).text);
    const r = await upgradeCopy(src, join(dir, "b"), { kicad: async () => { throw new Error("not called"); } });
    expect(r.method).toBe("none");
    expect(r.changed).toEqual([]);
  });
  test("netDifferences names pads and items whose net changed, and items gone", () => {
    const named = nameBoardNets(LEGACY_BOARD).text;
    const moved = named.replace('(pad "1" smd roundrect (at -0.825 0 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 1 "A")', '(pad "1" smd roundrect (at -0.825 0 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 2 "B")');
    expect(netDifferences(LEGACY_BOARD, moved)).toEqual(["pad R1.1: A -> B"]);
    const noZone = named.replace(/\n\t\(zone[\s\S]*?\n\t\)/, "");
    expect(netDifferences(LEGACY_BOARD, noZone)).toEqual(["zone @  (A) gone"]);
  });
});
