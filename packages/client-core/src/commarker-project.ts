import { z } from "zod/v4";
import { studioCopperGeometry } from "./commarker-project-geometry";

export const MAX_STUDIO_TEMPLATE_BYTES = 8 * 1024 * 1024;
const metadataKey = "__SERIALIZE__INFORMATION__";
const encodingMarker = Uint8Array.from("this is elfive\0\0", (c) => c.charCodeAt(0));
const value = z.number();
const integer = z.int();
const flag = z.boolean();
const penId = integer.min(0).max(31);
const empty = z.strictObject({});
const emptyData = z.strictObject({ variant: empty });
const shortText = z.string().max(255);
const metadata = z.strictObject({
  ver: z.literal("2.1.8595"), os: shortText, arch: z.literal(64), extension: z.literal(".orzr"), compiler: shortText,
});
const palette = z.object({ color: z.record(z.string().regex(/^(?:[0-9]|[12][0-9]|3[01])$/), z.tuple([value, value, value, value])) });
const material = z.strictObject({
  LightId: integer, SpeedPer: value, penId, penName: shortText, bEnable: z.literal(true),
  markCount: integer.positive(), runSpeed: value.positive(), laserPower: value.min(0).max(100),
  effectWaitTime: value, current: value, laserFreq: value.positive(), pulseWidth: value, mopaPulse: value,
  openDelay: value, shutDelay: value, endDelay: value, cornerDelay: value, bChangeCornerDelay: flag,
  pointTime: value, openBehind: value, jumpSpeed: value, jumpMinDelay: value, jumpMaxDelay: value,
  jumpMaxDist: value, firstJumpTime: value, firstFlyDelay: value,
  pulsePoint: z.strictObject({ bEnable: flag, pulsePerPoint: value }),
  stepMark: z.strictObject({ bEnable: flag, stepDelay: value, stepLen: value }),
  wobble: z.strictObject({ bEnable: flag, wobbleType: integer, wobbleDiaX: value, wobbleDiaY: value, wobbleSpace: value }),
  optFocus: z.strictObject({ bEnable: flag, startLen: value, endLen: value, interrupAngle: value }),
  cutMode: z.strictObject({ bEnable: flag, lightLen: value, gapLen: value, gapPower: value }),
  extParam: empty,
});
const hatch = z.strictObject({
  enabled: flag, fillType: integer, penID: penId, enableOutline: flag, caclAsOne: flag, localAsOne: flag,
  enableFillEvenly: flag, enableCrossFill: flag, fillAngle: value, fillSpace: value, rayStartAngle: value,
  rayLineCount: integer, startOffset: value, endOffset: value, lineIndent: value, outlineOffset: value,
  outlineRingCount: integer, outlineRingGap: value, clipType: integer, userData: emptyData,
});
const fill = z.strictObject({ layer: z.array(hatch).length(3), enableEdge: flag, edgeFirst: flag, simplify: flag, userData: emptyData });
const shapePreset = z.object({
  type: integer, penIndex: penId, userData: z.strictObject({ variant: z.record(z.string(), value) }), fillParam: fill,
  list: z.array(z.unknown()).optional(),
});
const project = z.object({
  [metadataKey]: metadata, colors: palette, shapes: z.array(z.unknown()).length(1),
  penPar: z.object({ params: z.array(z.object({ penId }).passthrough()).min(1).max(32) }),
});

export interface StudioTemplateSummary {
  penName: string;
  penIndex: number;
  fillLayers: number;
  fillSpacingMm: number[];
  speedMmPerSecond: number;
  powerPercent: number;
  passes: number;
  frequencyKHz: number;
}

const templateHint = "Save a Studio project with one filled vector using the tested copper pen.";
function readTemplate(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_STUDIO_TEMPLATE_BYTES) throw new Error("The Studio template exceeds 8 MiB.");
  if (bytes.length <= 8 || bytes.subarray(1, 8).some((n) => n !== 0) || (bytes[0] !== 0 && bytes[0] !== 1)) {
    throw new Error("Unsupported Studio project encoding. Choose a regular .orzr saved by ComMarker Studio.");
  }
  try {
    const payload = bytes.subarray(8);
    // The normal Save format (1) and Base64 format (0) serialize the same UTF-8 JSON.
    // The fixed 16-byte file marker was compared against our own stock Studio saves.
    const raw = bytes[0] === 1
      ? payload.map((byte, i) => byte ^ encodingMarker[i % encodingMarker.length]!)
      : Uint8Array.from(atob(new TextDecoder().decode(payload)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("The Studio template is damaged or unreadable. " + templateHint);
  }
}

const variantKeys = {
  Power: "laserPower", Times: "markCount", Speed: "runSpeed", LightId: "LightId",
  SpeedPer: "SpeedPer", Frequency: "laserFreq", PW: "pulseWidth", PWMOPA: "mopaPulse",
} as const;

function templateSettings(bytes: Uint8Array) {
  const result = project.safeParse(readTemplate(bytes));
  if (!result.success) throw new Error("Unsupported Studio project or artwork selection. " + templateHint);
  const document = result.data;
  // SVG imports can wrap a vector in a group. Exactly one shape or group may own Fill.
  // Multiple nested pen overrides can change marking order and cannot be transferred reliably.
  let shape: unknown = document.shapes[0];
  const vectorChain = [];
  for (;;) {
    const parsed = shapePreset.safeParse(shape);
    if (!parsed.success || vectorChain.length === 8) throw new Error("Unsupported Studio shape settings. " + templateHint);
    const current = parsed.data;
    vectorChain.push(current);
    if (current.type !== 22) {
      if (![1, 2, 3, 4, 5, 6].includes(current.type) || current.list) throw new Error(templateHint);
      break;
    }
    if (current.list?.length !== 1) throw new Error(templateHint);
    shape = current.list[0];
  }
  const filled = vectorChain.filter((s) => s.fillParam.layer.some((h) => h.enabled));
  const owner = filled[0];
  if (filled.length !== 1 || !owner) throw new Error("The template must have one unambiguous Fill operation. " + templateHint);
  const active = owner.fillParam.layer.filter((h) => h.enabled);
  if (active.some((h) => h.penID !== owner.penIndex || h.fillSpace <= 0)) {
    throw new Error("The shape and every active Fill layer must use one pen with positive hatch spacing.");
  }
  const candidates = document.penPar.params.filter((p) => p.penId === owner.penIndex);
  const penResult = material.safeParse(candidates[0]);
  if (candidates.length !== 1 || document.penPar.params[owner.penIndex] !== candidates[0] || !penResult.success) throw new Error("The selected Studio pen is missing, disabled, or uses unsupported settings.");
  const pen = penResult.data;
  const variant: Record<string, number> = {};
  for (const s of vectorChain) {
    for (const [name, setting] of Object.entries(s.userData.variant)) {
      const field = Object.hasOwn(variantKeys, name) ? variantKeys[name as keyof typeof variantKeys] : undefined;
      if (!field || pen[field] !== setting) throw new Error("Studio has conflicting or unsupported per-shape pen settings.");
      variant[name] = setting;
    }
  }
  const summary: StudioTemplateSummary = {
    penName: pen.penName, penIndex: pen.penId, fillLayers: active.length, fillSpacingMm: active.map((h) => h.fillSpace),
    speedMmPerSecond: pen.runSpeed, powerPercent: pen.laserPower, passes: pen.markCount, frequencyKHz: pen.laserFreq,
  };
  return { document, pen, owner, summary, variant };
}

export function inspectStudioTemplate(bytes: Uint8Array): StudioTemplateSummary {
  return templateSettings(bytes).summary;
}

/** Return a fresh, editable Studio document. The calibration artwork and its transform,
 * arrays and external data sources are discarded. No device connection is involved. */
export function makeStudioCopperProject(svg: string, templateBytes: Uint8Array): Uint8Array {
  const { document, pen, owner, variant } = templateSettings(templateBytes);
  const shape = { ...studioCopperGeometry(svg, { penIndex: pen.penId, fillParam: owner.fillParam }), userData: { variant } };
  // Studio looks up pens by table position as well as ID. Fill every preceding slot
  // with a complete disabled record so a nonzero source pen stays at its own index.
  const pens = Array.from({ length: pen.penId }, (_, penId) => ({ ...pen, penId, penName: "Unused", bEnable: false }));
  const json = JSON.stringify({
    title: "FabDesk front copper removal", shapes: [shape], dataSrources: { dataSourceMap: [] },
    colors: document.colors, [metadataKey]: document[metadataKey], defaultPenId: pen.penId, penPar: { params: [...pens, pen] },
  });
  const raw = new TextEncoder().encode(json);
  // Encode without spreading the entire board into a single JS call.
  const blocks: string[] = [];
  for (let offset = 0; offset < raw.length; offset += 0x6000) {
    blocks.push(btoa(String.fromCharCode(...raw.subarray(offset, offset + 0x6000))));
  }
  const base64 = blocks.join("");
  const output = new Uint8Array(8 + base64.length);
  new TextEncoder().encodeInto(base64, output.subarray(8));
  return output;
}
