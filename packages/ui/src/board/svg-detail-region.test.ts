import { expect, test } from "bun:test";
import { svgDetailRegion } from "./svg-detail-region";

test("deep zoom rasterizes the visible region rather than the entire long sheet", () => {
  const r=svgDetailRegion({ left:-300, top:-9000, width:3000, height:15000 }, { left:0, top:0, width:1200, height:800 }, 3000,15000,2)!;
  expect(r).toEqual({x:300,y:9000,width:1200,height:800,pixelsX:2400,pixelsY:1600});
});
test("partially visible drawings and transformed focus views retain source coordinates", () => {
  const r=svgDetailRegion({left:100,top:50,width:1000,height:2000},{left:0,top:0,width:800,height:600},2000,4000,1)!;
  expect(r).toEqual({x:0,y:0,width:1400,height:1100,pixelsX:700,pixelsY:550});
});
test("caps memory and skips offscreen or invalid geometry", () => {
  const r=svgDetailRegion({left:0,top:0,width:10000,height:10000},{left:0,top:0,width:8000,height:4000},10000,10000,4)!;
  expect(r.pixelsX*r.pixelsY).toBeLessThanOrEqual(4*1024*1024);
  expect(svgDetailRegion({left:200,top:0,width:100,height:100},{left:0,top:0,width:100,height:100},100,100,1)).toBeNull();
  expect(svgDetailRegion({left:0,top:0,width:0,height:100},{left:0,top:0,width:100,height:100},100,100,1)).toBeNull();
});
