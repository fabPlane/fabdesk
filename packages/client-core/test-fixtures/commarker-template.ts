// Synthetic file-format fixture. Its illustrative values are not a material preset.
const pen = {
  penId: 3, penName: "Format check µ", bEnable: true, LightId: 1, SpeedPer: 30, markCount: 2,
  runSpeed: 543.5, laserPower: 23, effectWaitTime: 20, current: 1, laserFreq: 37.5,
  pulseWidth: 1, mopaPulse: 10, openDelay: 0, shutDelay: 100, endDelay: 50, cornerDelay: 80,
  bChangeCornerDelay: true, pointTime: 100, openBehind: 0, jumpSpeed: 4000, jumpMinDelay: 300,
  jumpMaxDelay: 500, jumpMaxDist: 20, firstJumpTime: 6000, firstFlyDelay: 100,
  pulsePoint: { bEnable: false, pulsePerPoint: 10 }, stepMark: { bEnable: false, stepDelay: 100, stepLen: Math.fround(0.02) },
  wobble: { bEnable: false, wobbleType: 0, wobbleDiaX: 1, wobbleDiaY: 1, wobbleSpace: 0.5 },
  optFocus: { bEnable: false, startLen: 0.5, endLen: 0.5, interrupAngle: 0 },
  cutMode: { bEnable: false, lightLen: 2, gapLen: 0, gapPower: 0 }, extParam: {},
};
const layer = {
  enabled: true, fillType: 4, penID: 3, enableOutline: false, caclAsOne: false, localAsOne: false,
  enableFillEvenly: false, enableCrossFill: false, fillAngle: 23, fillSpace: 0.1, rayStartAngle: 0,
  rayLineCount: 360, startOffset: 0, endOffset: 0, lineIndent: 0, outlineOffset: 0, outlineRingCount: 0,
  outlineRingGap: 0.5, clipType: 4, userData: { variant: {} },
};
const fill = { layer: [layer, { ...layer, enabled: false }, { ...layer, enabled: false }], enableEdge: false, edgeFirst: false, simplify: false, userData: { variant: {} } };
const variant = { Power: 23, Times: 2, Speed: 543.5, LightId: 1, SpeedPer: 30, Frequency: 37.5, PW: 1, PWMOPA: 10 };
export const studioFixtureDocument = {
  title: "Discard me", shapes: [{ type: 5, penIndex: 3, fillParam: fill, userData: { variant },
    arrayParam: { enabled: true }, matrix: [1, 0, 0, 1, 100, 200] }],
  penPar: { params: [0, 1, 2].map((penId) => ({ ...pen, penId, penName: "Unrelated" })).concat([pen]) },
  colors: { color: { "3": [30, 40, 50, 100] } }, defaultPenId: 0, dataSrources: { dataSourceMap: ["discard"] },
  __SERIALIZE__INFORMATION__: { ver: "2.1.8595", os: "test", compiler: "test", arch: 64, extension: ".orzr" },
};


export function encodeStudioFixture(document: unknown = studioFixtureDocument, mode: 0 | 1 = 1) {
  const raw = Buffer.from(JSON.stringify(document));
  const marker = Buffer.from("7468697320697320656c666976650000", "hex");
  const bytes = mode === 0 ? Buffer.from(raw.toString("base64")) : raw.map((b, i) => b ^ marker[i % 16]!);
  const header = Buffer.alloc(8);
  header[0] = mode;
  return Buffer.concat([header, bytes]);
}
