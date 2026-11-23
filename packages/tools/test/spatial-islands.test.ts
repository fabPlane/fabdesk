import { describe, expect, test } from "bun:test";
import { connectedComponentsForNet } from "../src/tools/spatial";

const pad = (id: string, x: number, y: number) => ({ id, net: "SIG", x, y, width: 1, height: 1 });
const track = (id: string, a: [number, number], b: [number, number], layer = "F.Cu") => ({ id, net: "SIG", layer, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } });

describe("islandsOfNet", () => {
  test("a pad-track-bend-track-pad route is one island; tracks meeting on different layers without a via are not joined", () => {
    const pads = [pad("p1", 0, 0), pad("p2", 10, 5)];
    const one = connectedComponentsForNet("SIG", { pads, vias: [], tracks: [track("t1", [0, 0], [5, 0]), track("t2", [5, 0], [10, 5])], zones: [] });
    expect(one).toHaveLength(1);
    const two = connectedComponentsForNet("SIG", { pads, vias: [], tracks: [track("t1", [0, 0], [5, 0]), track("t2", [5, 0], [10, 5], "B.Cu")], zones: [] });
    expect(two).toHaveLength(2);
  });
});
