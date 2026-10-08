import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copperBoard, netFacts, quality, qualityText, recordRemoval, referenceFacts, consumeReference } from "../src/routing-quality";

test("FFC seed and routed candidate match independent accept_lib fixtures", async () => {
  const root = join(import.meta.dir,"fixtures/routing-quality");
  const expected = await Bun.file(join(root,"accept-lib-expected.json")).json();
  for (const name of ["ffc-seed.kicad_pcb","ffc-candidate.kicad_pcb"]) {
    const board = copperBoard(await readFile(join(root,name),"utf8"));
    expect(board.revision).toBe(expected[name].sha256);
    for (const actual of netFacts(board,Object.keys(expected[name].nets))) {
      const oracle = expected[name].nets[actual.net];
      expect(actual.lengthMm).toBeCloseTo(oracle.length,3);
      expect(actual.minWidthMm).toBe(oracle.minWidth);
      expect(actual.viaCount).toBe(oracle.vias);
      expect(actual.layers).toEqual(expect.arrayContaining(oracle.layers));
    }
  }
});

const segment = (id: string, net: string, width: number, end: number) => `(segment (start 0 0) (end ${end} 0) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${id}"))`;
const boardOf = (items: string) => copperBoard(`(kicad_pcb (net "A_P") (net "A_N") ${items})`);
test("length weighting, declared-pair precedence and bounded fact text", () => {
  const board=boardOf(segment("a","A_P",0.2,1)+segment("b","A_P",0.3,10)+segment("c","A_N",0.2,11));
  expect(netFacts(board)[1]?.dominantWidthMm).toBe(0.3);
  const q=quality(board,board.nets,[{p:"A_P",n:"A_N"}]);
  expect(q.pairs).toHaveLength(1); expect(q.pairs[0]?.identification).toBe("declared"); expect(q.pairs[0]?.skewMm).toBe(0);
  expect(Buffer.byteLength(qualityText(q,220))).toBeLessThanOrEqual(220);
});
test("sequential removals keep first full-net reference; consumption is net-scoped", async () => {
  const dir=await mkdtemp(join(tmpdir(),"routing-facts-"));
  try {
    const before=boardOf(segment("a","A_P",0.3,10)+segment("b","A_P",0.2,2)+segment("c","A_N",0.2,11));
    const first=boardOf(segment("b","A_P",0.2,2)+segment("c","A_N",0.2,11));
    const second=boardOf(segment("c","A_N",0.2,11));
    expect((await recordRemoval(dir,before,first))?.nets[0]?.lengthMm).toBe(10);
    await recordRemoval(dir,first,second);
    expect((await referenceFacts(dir,second.revision))[0]?.lengthMm).toBe(12);
    expect(await referenceFacts(dir,"different-revision")).toEqual([]);
    await consumeReference(dir,second.revision,"applied",["A_N"]);
    expect((await referenceFacts(dir,"applied"))[0]?.net).toBe("A_P");
    await consumeReference(dir,"applied","complete",["A_P"]);
    expect(await referenceFacts(dir,"complete")).toEqual([]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
