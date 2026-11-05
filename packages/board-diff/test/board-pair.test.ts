import { describe, expect, test } from "bun:test";
import { boardDrawingSvg, boardPadBoxes, boardPairDrawings, boardPartBounds, boardSize, compareBoardPair, normalizeBoardOrigin, snapshotFromKicadPcb } from "../src";
import { PCB_FROM, PCB_TO } from "./fixtures";

const part = (ref: string, x: number, y: number, extra = "") => `(footprint "Lib:Part"
    (layer "F.Cu")
    ${extra}
    (at ${x} ${y} 0)
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "1k" (at 0 0 0))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "SIG"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "GND"))
  )`;
const board = (parts: string[], outline = "(gr_rect (start 0 0) (end 50 40) (stroke (width 0.1)) (layer \"Edge.Cuts\"))") => snapshotFromKicadPcb(`(kicad_pcb
  (version 20241201)
  (net 0 "") (net 1 "SIG") (net 2 "GND")
  ${parts.join("\n  ")}
  ${outline}
)`);

describe("compareBoardPair", () => {
  test("reports added, removed and moved parts with their distance", () => {
    const from = board([part("R1", 10, 10), part("R2", 20, 20)]);
    const to = board([part("R1", 13, 14), part("C1", 30, 30)]);
    const { changes, summary } = compareBoardPair(from, to);
    expect(summary).toMatchObject({ added: 1, removed: 1, moved: 1, changed: 0, renamed: 0 });
    expect(changes.find((c) => c.kind === "moved")).toMatchObject({ fromRef: "R1", toRef: "R1", dx: 3, dy: 4, distance: 5 });
    expect(changes.find((c) => c.kind === "added")).toMatchObject({ toRef: "C1" });
    expect(changes.find((c) => c.kind === "added")?.fromRef).toBeUndefined();
    expect(changes.find((c) => c.kind === "removed")).toMatchObject({ fromRef: "R2" });
    expect(changes.find((c) => c.kind === "removed")?.toRef).toBeUndefined();
  });

  test("identical boards report nothing", () => {
    const { changes, summary } = compareBoardPair(snapshotFromKicadPcb(PCB_FROM), snapshotFromKicadPcb(PCB_FROM));
    expect(changes).toEqual([]);
    expect(summary.unchanged).toBeGreaterThan(0);
  });

  test("a board moved on the KiCad sheet is not a design change", () => {
    const from = board([part("R1", 10, 10)]);
    const to = board([part("R1", 110, 210)], "(gr_rect (start 100 200) (end 150 240) (stroke (width 0.1)) (layer \"Edge.Cuts\"))");
    expect(compareBoardPair(from, to).changes).toEqual([]);
  });

  test("the same native identity with a new reference is a rename, not remove and add", () => {
    const uuid = '(uuid "aaaaaaaa-0000-0000-0000-000000000001")';
    const { changes, summary } = compareBoardPair(board([part("C1", 10, 10, uuid)]), board([part("C9", 10, 10, uuid)]));
    expect(summary).toMatchObject({ renamed: 1, added: 0, removed: 0 });
    expect(changes[0]).toMatchObject({ kind: "renamed", fromRef: "C1", toRef: "C9" });
  });

  test("a schematic path outranks a footprint uuid when matching identity", () => {
    const a = '(uuid "aaaaaaaa-0000-0000-0000-000000000001") (path "/sheet/one")';
    const b = '(uuid "bbbbbbbb-0000-0000-0000-000000000002") (path "/sheet/one")';
    expect(compareBoardPair(board([part("C1", 10, 10, a)]), board([part("C9", 10, 10, b)])).summary.renamed).toBe(1);
    const different = '(uuid "aaaaaaaa-0000-0000-0000-000000000001") (path "/sheet/two")';
    expect(compareBoardPair(board([part("C1", 10, 10, a)]), board([part("C9", 10, 10, different)])).summary).toMatchObject({ renamed: 0, added: 1, removed: 1 });
  });

  test("a new reference with no shared identity stays remove and add", () => {
    expect(compareBoardPair(board([part("C1", 10, 10)]), board([part("C9", 10, 10)])).summary).toMatchObject({ renamed: 0, added: 1, removed: 1 });
  });

  test("the fixture revision pair reports the same parts as the existing diff", () => {
    const comparison = compareBoardPair(snapshotFromKicadPcb(PCB_FROM), snapshotFromKicadPcb(PCB_TO));
    expect(comparison.changes.map((c) => c.toRef ?? c.fromRef).sort()).toEqual([...comparison.diff.components.added, ...comparison.diff.components.removed, ...comparison.diff.components.changed].map((c) => c.ref).sort());
  });
});

describe("parser additions", () => {
  test("reads native identities and pad positions, including v10 transforms", () => {
    const snapshot = snapshotFromKicadPcb(`(kicad_pcb
      (footprint "Lib:Part" (layer "F.Cu") (uuid "abc-1") (path "/x/y")
        (transform (translate 5 6) (rotate 90) (scale 1 1))
        (property "Reference" "U1" (at 0 0 0))
        (pad "1" smd rect (at 1 2 90) (size 1 2) (layers "F.Cu"))
      ))`);
    expect(snapshot.components[0]).toMatchObject({ ref: "U1", uuid: "abc-1", symbolPath: "/x/y", x: 5, y: 6, rotation: 90 });
    expect(snapshot.components[0]?.pads?.[0]).toMatchObject({ pin: "1", x: 1, y: 2, angle: 90 });
  });

  test("includes arcs and circles in the board outline", () => {
    const arc = snapshotFromKicadPcb(`(kicad_pcb (gr_arc (start 0 0) (mid 5 5) (end 10 0) (layer "Edge.Cuts")))`);
    expect(boardSize(arc)?.width).toBeCloseTo(10, 5);
    const circle = snapshotFromKicadPcb(`(kicad_pcb (gr_circle (center 10 10) (end 15 10) (layer "Edge.Cuts")))`);
    expect(boardSize(circle)?.width).toBeCloseTo(10, 5);
    expect(boardSize(circle)?.height).toBeCloseTo(10, 1);
  });
});

describe("drawings", () => {
  test("a rotated part's bounds follow its pads", () => {
    const rotated = snapshotFromKicadPcb(`(kicad_pcb (footprint "L:P" (layer "F.Cu") (at 10 10 90)
      (property "Reference" "R1" (at 0 0 0))
      (pad "1" smd rect (at -2 0 90) (size 1 1) (layers "F.Cu"))
      (pad "2" smd rect (at 2 0 90) (size 1 1) (layers "F.Cu"))))`);
    const box = boardPartBounds(rotated.components[0]!)!;
    expect(box.maxX - box.minX).toBeCloseTo(1, 5);
    expect(box.maxY - box.minY).toBeCloseTo(5, 5);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(10, 5);
  });

  test("a part with no pads still gets a selectable area", () => {
    const snapshot = snapshotFromKicadPcb(`(kicad_pcb (footprint "L:P" (layer "F.Cu") (at 3 4 0) (property "Reference" "H1" (at 0 0 0))))`);
    expect(boardPartBounds(snapshot.components[0]!)).toEqual({ minX: 2.2, minY: 3.2, maxX: 3.8, maxY: 4.8 });
  });

  test("removed parts draw only on the older board, added only on the newer, at one scale", () => {
    const comparison = compareBoardPair(board([part("R1", 10, 10), part("GONE", 20, 20)]), board([part("R1", 13, 14), part("NEW", 30, 30)]));
    const { from, to } = boardPairDrawings(comparison);
    expect(from).toContain('data-ref="GONE" data-role="removed"');
    expect(to).not.toContain('data-ref="GONE"');
    expect(to).toContain('data-ref="NEW" data-role="added"');
    expect(from).not.toContain('data-ref="NEW"');
    expect(from).toContain('data-ref="R1" data-role="moved"');
    expect(to).toContain('data-ref="R1" data-role="moved"');
    const viewBox = (svg: string) => /viewBox="([^"]+)"/.exec(svg)?.[1];
    expect(viewBox(from)).toBe(viewBox(to));
  });

  test("each pad has placed bounds and a tagged drawing for picking pins", () => {
    const rotated = snapshotFromKicadPcb(`(kicad_pcb (footprint "L:P" (layer "F.Cu") (at 10 10 90)
      (property "Reference" "R1" (at 0 0 0))
      (pad "1" smd rect (at -2 0 90) (size 1 1) (layers "F.Cu") (net 1 "SIG"))
      (pad "2" smd rect (at 2 0 90) (size 1 1) (layers "F.Cu"))))`);
    const pads = boardPadBoxes(rotated.components[0]!);
    expect(pads.map((row) => row.pin)).toEqual(["1", "2"]);
    expect(pads[0]?.net).toBe("SIG");
    expect((pads[0]!.bounds.minY + pads[0]!.bounds.maxY) / 2).toBeCloseTo(12, 5);
    expect((pads[1]!.bounds.minY + pads[1]!.bounds.maxY) / 2).toBeCloseTo(8, 5);
    const svg = boardDrawingSvg(rotated);
    expect(svg).toContain('data-pin="1"');
    expect(svg).toContain('class="bp-pin" display="none"');
  });

  test("references are escaped in the drawing", () => {
    expect(boardDrawingSvg(board([part("A&B", 10, 10)]))).toContain('data-ref="A&amp;B"');
  });

  test("normalizing keeps a board already at the origin untouched", () => {
    const snapshot = board([part("R1", 10, 10)]);
    expect(normalizeBoardOrigin(snapshot)).toBe(snapshot);
  });
});
