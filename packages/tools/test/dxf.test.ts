import { describe, expect, test } from "bun:test";
import { dxfToSvg } from "../src";

/** Group-code / value pairs → DXF text. */
const dxf = (...entities: Array<Array<[number, string | number]>>): string =>
  [
    [0, "SECTION"],
    [2, "HEADER"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
    ...entities.flat(),
    [0, "ENDSEC"],
    [0, "EOF"],
  ]
    .map(([code, value]) => `  ${code}\n${value}`)
    .join("\n");

describe("dxfToSvg", () => {
  test("draws lines, circles and arcs with a Y-flipped viewBox in drawing units", () => {
    const out = dxfToSvg(
      dxf(
        [
          [0, "LINE"],
          [8, "Edge.Cuts"],
          [10, 0],
          [20, 0],
          [11, 40],
          [21, 0],
        ],
        [
          [0, "CIRCLE"],
          [8, "F.Cu"],
          [10, 10],
          [20, 10],
          [40, 2.5],
        ],
        [
          [0, "ARC"],
          [8, "F.Cu"],
          [10, 30],
          [20, 10],
          [40, 5],
          [50, 0],
          [51, 90],
        ],
      ),
    );
    expect(out.entities).toBe(3);
    expect(out.layers).toEqual(["Edge.Cuts", "F.Cu"]);
    expect(out.bounds).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 15 });
    expect(out.svg).toContain('<line data-layer="Edge.Cuts" x1="0" y1="0" x2="40" y2="0"/>');
    expect(out.svg).toContain('<circle data-layer="F.Cu" cx="10" cy="10" r="2.5"/>');
    // Quarter arc from (35,10) counter-clockwise to (30,15): small arc, positive sweep.
    expect(out.svg).toContain('d="M35 10 A5 5 0 0 1 30 15"');
    expect(out.svg).toContain('transform="scale(1,-1)"');
    // 2% padding around a 40 × 15 drawing; Y spans [-maxY, -minY] after the flip.
    expect(out.svg).toContain('viewBox="-0.8 -15.8 41.6 16.6"');
  });

  test("closed LWPOLYLINE with a bulge becomes an arc segment; widths are kept", () => {
    const out = dxfToSvg(
      dxf([
        [0, "LWPOLYLINE"],
        [8, "Edge.Cuts"],
        [90, 3],
        [70, 1],
        [43, 0.2],
        [10, 0],
        [20, 0],
        [10, 10],
        [20, 0],
        [42, 1],
        [10, 10],
        [20, 10],
      ]),
    );
    expect(out.entities).toBe(1);
    // Bulge 1 is a half circle (radius = chord / 2) drawn counter-clockwise.
    expect(out.svg).toContain('d="M0 0 L10 0 A5 5 0 0 1 10 10 L0 0 Z"');
    expect(out.svg).toContain("stroke-width:0.2");
  });

  test("POLYLINE vertices are gathered up to SEQEND; unsupported entities are reported", () => {
    const out = dxfToSvg(
      dxf(
        [
          [0, "POLYLINE"],
          [8, "0"],
          [66, 1],
          [70, 0],
        ],
        [
          [0, "VERTEX"],
          [10, 1],
          [20, 2],
        ],
        [
          [0, "VERTEX"],
          [10, 3],
          [20, 4],
        ],
        [[0, "SEQEND"]],
        [
          [0, "TEXT"],
          [10, 0],
          [20, 0],
          [1, "hello"],
        ],
        [
          [0, "INSERT"],
          [2, "BLOCK1"],
        ],
      ),
    );
    expect(out.entities).toBe(1);
    expect(out.svg).toContain('d="M1 2 L3 4"');
    expect(out.skipped).toEqual({ TEXT: 1, INSERT: 1 });
  });

  test("escapes layer names and survives empty input", () => {
    const out = dxfToSvg(
      dxf([
        [0, "LINE"],
        [8, 'a"<b>'],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
      ]),
    );
    expect(out.svg).toContain('data-layer="a&#34;&#60;b&#62;"');
    const empty = dxfToSvg("");
    expect(empty.entities).toBe(0);
    expect(empty.bounds).toBeNull();
    expect(empty.svg.startsWith("<svg")).toBe(true);
  });
});
