import { describe, expect, test } from "bun:test";
import { inspectStudioTemplate, makeStudioCopperProject, MAX_STUDIO_TEMPLATE_BYTES } from "./commarker-project";

import { encodeStudioFixture as encode, studioFixtureDocument as source } from "../test-fixtures/commarker-template";

const pen = source.penPar.params[3]!;
const { fillParam: fill, userData: { variant } } = source.shapes[0]!;
const layer = fill.layer[0]!;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3mm" height="2mm" viewBox="0 0 3 2">\n<title>Front copper to remove</title>\n<path fill="#000000" fill-rule="evenodd" stroke="none" d="M0 0 L3 0 L3 2 L0 2 Z"/>\n</svg>';

function decode(bytes: Uint8Array) {
  return JSON.parse(Buffer.from(Buffer.from(bytes.subarray(8)).toString(), "base64").toString("utf8"));
}

describe("native Studio copper template", () => {
  test.each([0, 1] as const)("reads encoding %i, retaining the selected pen at its actual table position", (mode) => {
    const bytes = encode(source, mode);
    expect(inspectStudioTemplate(bytes)).toEqual({
      penName: pen.penName, penIndex: 3, fillLayers: 1, fillSpacingMm: [0.1], speedMmPerSecond: 543.5,
      powerPercent: 23, passes: 2, frequencyKHz: 37.5,
    });
    const job = decode(makeStudioCopperProject(svg, bytes));
    expect(job.penPar.params[3]).toEqual(pen);
    expect(job.penPar.params.slice(0, 3).map((p: typeof pen) => [p.penId, p.bEnable])).toEqual([[0, false], [1, false], [2, false]]);
    expect(job.defaultPenId).toBe(3);
    expect(job.shapes).toHaveLength(1);
    expect(job.shapes[0]).toMatchObject({
      type: 4, penIndex: 3, fillParam: fill, userData: { variant }, arrayParam: { enabled: false }, matrix: [1, 0, 0, 1, 0, 0],
    });
    expect(job.dataSrources).toEqual({ dataSourceMap: [] });
    expect(JSON.stringify(job)).not.toContain("Unrelated");
    expect(inspectStudioTemplate(makeStudioCopperProject(svg, bytes))).toEqual(inspectStudioTemplate(bytes));
  });

  test("accepts neutral single-vector groups and multiple active layers of the same pen", () => {
    const child = { ...source.shapes[0], fillParam: { ...fill, layer: [layer, { ...layer, fillSpace: 0.25 }, { ...layer, enabled: false }] } };
    const wrapped = { ...source, shapes: [{ type: 22, penIndex: 0, fillParam: { ...fill, layer: fill.layer.map((l) => ({ ...l, enabled: false })) }, userData: { variant: {} }, list: [child] }] };
    expect(inspectStudioTemplate(encode(wrapped)).fillSpacingMm).toEqual([0.1, 0.25]);
    expect(decode(makeStudioCopperProject(svg, encode(wrapped))).shapes[0].userData).toEqual({ variant });
  });

  test("rejects ambiguous, disabled, missing or inconsistent pen and Fill records", () => {
    const shape = source.shapes[0]!;
    for (const bad of [
      { ...source, shapes: [] }, { ...source, shapes: [shape, shape] },
      { ...source, shapes: [{ ...shape, type: 22, list: [shape] }] },
      { ...source, shapes: [{ ...shape, fillParam: { ...fill, layer: fill.layer.map((l) => ({ ...l, enabled: false })) } }] },
      { ...source, shapes: [{ ...shape, fillParam: { ...fill, layer: [ { ...layer, penID: 1 }, ...fill.layer.slice(1) ] } }] },
      { ...source, shapes: [{ ...shape, fillParam: { ...fill, layer: [ { ...layer, fillSpace: 0 }, ...fill.layer.slice(1) ] } }] },
      { ...source, shapes: [{ ...shape, userData: { variant: { Speed: 123 } } }] },
      { ...source, shapes: [{ ...shape, userData: { variant: { AnotherSetting: 1 } } }] },
      { ...source, penPar: { params: [pen] } },
      { ...source, penPar: { params: source.penPar.params.map((p) => ({ ...p, bEnable: false })) } },
      { ...source, penPar: { params: [...source.penPar.params, pen] } },
      { ...source, __SERIALIZE__INFORMATION__: { ...source.__SERIALIZE__INFORMATION__, ver: "unknown" } },
    ]) expect(() => inspectStudioTemplate(encode(bad))).toThrow();
  });

  test("unsupported files are rejected before geometry conversion", () => {
    const corrupt = encode(source, 1);
    corrupt[8] = 0xff;
    for (const bytes of [new Uint8Array(), new Uint8Array(MAX_STUDIO_TEMPLATE_BYTES + 1), Uint8Array.of(3,0,0,0,0,0,0,0,1), corrupt]) {
      expect(() => makeStudioCopperProject(svg, bytes)).toThrow();
    }
    expect(() => makeStudioCopperProject("<svg/>", encode(source))).toThrow();
  });
});
