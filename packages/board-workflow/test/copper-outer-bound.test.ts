import { expect, test } from "bun:test";
import { padCopper } from "../src/edit/prune-copper";
import { copperContact, copperShapesTouch } from "../src/copper-contact";
import { pruneDangling } from "../src/edit/prune";
import { fpT, seg } from "./edit-fixture";

test("small selected chamfer retains the live track and via outside the rounded corner", () => {
  const chamfer = fpT("U1",0,0,[["1","A",0,0]]).replace("smd rect","smd roundrect")
    .replace("(size 0.6 0.6)","(size 4 4) (roundrect_rratio .25) (chamfer_ratio .05) (chamfer top_right)");
  const bridge = seg(1.9,-1.7,6,-1.7,"A");
  const via = '(via (at 1.9 -1.7) (size .2) (drill .1) (layers "F.Cu" "B.Cu") (net "A"))';
  const text = `(kicad_pcb ${chamfer} ${fpT("U2",6,-1.7,[["1","A",0,0]])} ${bridge} ${via})`;
  const shape = padCopper(text,["F.Cu","B.Cu"])[0]!.shape;
  expect(copperShapesTouch(shape,["F.Cu"],{path:[{x:1.9,y:-1.7}],width:0},["F.Cu"],"F.Cu")).toBe(true);
  const result = pruneDangling(text,new Set(["A"]));
  expect(result.pruned).toBe(0);
  expect(result.text).toContain(bridge);
  expect(result.text).toContain(via);
});

// Seeded property sampling: the reference points use analytic pad boundaries,
// independently of the retention adapter. Drill offsets deliberately exercise
// asymmetric geometry relative to the anchor, and all 16 corner subsets occur.
test("randomised KiCad pad copper is contained by a circular unknown bound", () => {
  let seed = 0x918abc;
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223) >>> 0) / 2**32);
  const corners = ["top_left","top_right","bottom_left","bottom_right"];
  for (const drilled of [false,true]) for (const kind of ["circle","rect","oval","roundrect","trapezoid","custom"]) for (let n=0;n<64;n++) {
    const w = .2+8*random(), h = kind === "circle" ? w : .2+8*random();
    const rot = 720*random()-360, angle = rot*Math.PI/180;
    const ox = drilled ? 8*random()-4 : 0, oy = drilled ? 8*random()-4 : 0, rounding = random()/2, chamfer = random()/2;
    const selected = corners.filter((_,i) => (n & (1<<i)) !== 0);
    const extra = kind === "roundrect" ? `(roundrect_rratio ${rounding}) (chamfer_ratio ${chamfer}) (chamfer ${selected.join(" ")})` :
      kind === "trapezoid" ? `(rect_delta ${w/3} 0)` : kind === "custom" ? '(options (anchor rect)) (primitives (gr_circle (center 6 -3) (end 8 -3) (width .4) (fill yes)) (gr_poly (pts (xy -7 2) (xy -5 4) (xy -8 5)) (width .3) (fill yes)))' : '';
    const text = `(kicad_pcb (footprint "test" (layer "F.Cu") (at 11 13 23)
      (pad "1" ${drilled ? "thru_hole" : "smd"} ${kind} (at 0 0 ${rot}) (size ${w} ${h})
      ${drilled ? `(drill .1 (offset ${ox} ${oy}))` : ""} (layers "*.Cu") (net "A") ${extra})))`;
    const pad = padCopper(text,["F.Cu","In1.Cu","B.Cu"])[0]!;
    const unknown = drilled || ["roundrect","trapezoid","custom"].includes(kind);
    if (unknown) expect("path" in pad.shape && pad.shape.path.length === 1).toBe(true);
    expect(copperContact(pad.shape,pad.layers,pad.shape,pad.layers,"F.Cu").surelyTouches).toBe(!unknown);
    const points: Array<[number,number]> = [];
    for (let i=0;i<48;i++) {
      const a=i*Math.PI/24, c=Math.cos(a), s=Math.sin(a);
      if (kind === "circle") points.push([w/2*c,w/2*s]);
      else if (kind === "oval") { const r=Math.min(w,h)/2; points.push([(w/2-r)*Math.sign(c)+r*c,(h/2-r)*Math.sign(s)+r*s]); }
      else if (kind === "roundrect") {
        const r=Math.min(w,h)*rounding;
        points.push([(w/2-r)*Math.sign(c)+r*c,(h/2-r)*Math.sign(s)+r*s]);
        // Selected chamfer edges can extend outside the rounded boundary.
        for (const corner of selected) { const sx=corner.includes("left")?-1:1, sy=corner.includes("top")?-1:1;
          const d=Math.min(w,h)*chamfer; points.push([sx*w/2,sy*(h/2-d)],[sx*(w/2-d),sy*h/2]); }
      } else if (kind === "trapezoid") points.push([-w/2,-h/2+w/6],[w/2,-h/2-w/6],[w/2,h/2+w/6],[-w/2,h/2-w/6]);
      else if (kind === "custom") points.push([6+2.2*c,-3+2.2*s],[-7,2],[-5,4],[-8,5]);
      else points.push([w/2*Math.sign(c),h/2*Math.sign(s)]);
    }
    for (const [px,py] of points) {
      const x=px*(1-1e-12)+ox, y=py*(1-1e-12)+oy;
      const point={x:11+x*Math.cos(angle)+y*Math.sin(angle),y:13-x*Math.sin(angle)+y*Math.cos(angle)};
      for (const layer of pad.layers) expect(copperShapesTouch(pad.shape,pad.layers,{path:[point],width:0},[layer],layer)).toBe(true);
    }
  }
});
