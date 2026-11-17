import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { padCopper } from "../src/edit/prune-copper";
import { copperContact, copperShapesTouch } from "../src/copper-contact";
import { pruneDangling } from "../src/edit/prune";
import { fpT, seg } from "./edit-fixture";

const stack = ["F.Cu", "In1.Cu", "B.Cu"];
const touches = (text: string, x: number, y: number) => {
  const pad = padCopper(text, stack)[0]!;
  for (const layer of stack) expect(copperShapesTouch(pad.shape, pad.layers, { path: [{ x, y }], width: 0 }, [layer], layer)).toBe(true);
  expect(copperContact(pad.shape, pad.layers, pad.shape, pad.layers, "F.Cu").surelyTouches).toBe(false);
};

test("native KiCad 10 back-layer land retains the connected track and via", () => {
  const text = readFileSync(new URL("./fixtures/padstack.kicad_pcb", import.meta.url), "utf8");
  const land = padCopper(text, stack)[1]!; // Native serialization places U2 before U1.
  expect(copperShapesTouch(land.shape,land.layers,{path:[{x:1.5,y:0}],width:0},["B.Cu"],"B.Cu")).toBe(true);
  const result = pruneDangling(text, new Set(["A"]));
  expect(result.pruned).toBe(0);
});

for (const mode of ["custom", "front_inner_back"]) for (const layer of ["F.Cu", "Inner", "B.Cu"]) {
  test(`${mode} ${layer} land includes size, offset and custom primitives on every spanned layer`, () => {
    const pad = fpT("U1", 0, 0, [["1", "A", 0, 0]])
      .replace('(size 0.6 0.6)', `(size .6 .6) (padstack (mode ${mode}) (layer "${layer}" (shape custom) (size 4 6) (offset 2 1) (primitives (gr_circle (center 7 0) (end 8 0) (width .4) (fill yes)))))`)
      .replace('(layers "F.Cu" "F.Paste")', '(layers "*.Cu")');
    touches(`(kicad_pcb ${pad})`, 10.1, 1);
  });
}

for (const extra of ['(future_copper (extent 4))', '(options (anchor rect) (future_option 4))', '(padstack (mode custom) (layer "B.Cu" (future_geometry 4)))', '(primitives (gr_future_shape (size 4 4)))', '(at 0 0 (future_transform 4))']) {
  test(`unmodelled pad property uses courtyard on all copper layers: ${extra}`, () => {
    const fp = fpT("U1", 0, 0, [["1", "A", 0, 0]]).replace('(size 0.6 0.6)', `(size .6 .6) ${extra}`)
      .replace('(pad "1"', '(fp_rect (start -5 -4) (end 5 4) (stroke (width .05) (type default)) (fill none) (layer "F.CrtYd")) (pad "1"');
    const text = `(kicad_pcb ${fp})`;
    touches(text, 4.9, 3.9);
    const bridge = seg(4, 0, 9, 0, "A");
    const board = `(kicad_pcb ${fp} ${fpT("U2", 9, 0, [["1", "A", 0, 0]])} ${bridge})`;
    expect(pruneDangling(board, new Set(["A"])).pruned).toBe(0);
  });
}

test("without courtyard the catch-all covers all other pads and footprint copper", () => {
  const fp = fpT("U1", 0, 0, [["1", "A", 0, 0], ["2", "B", 8, 0]])
    .replace(/\(fp_rect[^\n]+\n/, '')
    .replace('(size 0.6 0.6)', '(size .6 .6) (future_copper 1)')
    .replace('(pad "1"', '(fp_circle (center 12 0) (end 14 0) (stroke (width .2) (type default)) (fill solid) (layer "B.Cu")) (pad "1"');
  touches(`(kicad_pcb ${fp})`, 14, 0);
});

test("only identical allow-listed layer lands can certify a padstack", () => {
  for (const [shape, size, exact] of [["rect", "0.6 0.6", true], ["circle", "0.6 0.6", false], ["rect", "4 4", false]] as const) {
    const fp = fpT("U1", 0, 0, [["1", "A", 0, 0]])
      .replace('(size 0.6 0.6)', `(size 0.6 0.6) (padstack (mode custom) (layer "B.Cu" (shape ${shape}) (size ${size})))`);
    const pad = padCopper(`(kicad_pcb ${fp})`, stack)[0]!;
    expect(copperContact(pad.shape,pad.layers,pad.shape,pad.layers,"F.Cu").surelyTouches).toBe(exact);
  }
});

test("unknown footprint property uses its rotated courtyard on all layers", () => {
  const fp = fpT("U1",10,20,[["1","A",0,0]],{box:[-5,-4,5,4],rot:90})
    .replace('(pad "1"','(future_footprint_copper (expansion 4)) (pad "1"');
  touches(`(kicad_pcb ${fp})`,13.9,15.1);
});

test("layer-specific via lands retain copper beyond the top-level diameter", async () => {
  const { routeCopper } = await import("../src/edit/prune-copper");
  const { parseSexpr } = await import("../src/sexpr");
  const via = routeCopper(parseSexpr('(via (at 0 0) (size .6) (layers "F.Cu" "B.Cu") (net "A") (padstack (mode custom) (layer "B.Cu" (size 4) (offset 1 0))))'), stack);
  for (const layer of stack) expect(copperShapesTouch(via.shape,via.layers,{path:[{x:2.9,y:0}],width:0},[layer],layer)).toBe(true);
  expect(copperContact(via.shape,via.layers,via.shape,via.layers,"F.Cu").surelyTouches).toBe(false);
});

test("unmodelled copper in a padless footprint still retains an incident route", () => {
  const fp = '(footprint "copper" (layer "F.Cu") (at 0 0) (fp_rect (start -5 -4) (end 5 4) (layer "B.Cu") (fill solid)))';
  const bridge = seg(4,0,9,0,"A","B.Cu");
  const other = fpT("U2",9,0,[["1","A",0,0]]).replace('(layers "F.Cu" "F.Paste")','(layers "*.Cu")');
  expect(pruneDangling(`(kicad_pcb ${fp} ${other} ${bridge})`,new Set(["A"])).pruned).toBe(0);
});
