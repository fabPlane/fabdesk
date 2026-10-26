import { expect, test } from "bun:test";
import { pcmWav } from "./native-wav";

test("native recordings are mono little-endian PCM WAV with clipped samples", () => {
  const wav = pcmWav(new Float32Array([-2, 0, 2]), 48000);
  const view = new DataView(wav);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
  expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(46, true)).toBe(0);
  expect(view.getInt16(48, true)).toBe(32767);
});
