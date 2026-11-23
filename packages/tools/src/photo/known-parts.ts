import type { KnownScalePart } from "@fabdesk/protocol";

/** Published body sizes used to turn a recognised part in the photo into millimetres. */
export const KNOWN_PART_SIZES_MM: Record<KnownScalePart, { widthMm: number; heightMm: number; label: string }> =
  {
    usb_c: { widthMm: 8.94, heightMm: 7.35, label: "USB-C receptacle shell" },
    usb_a: { widthMm: 12.0, heightMm: 5.0, label: "USB-A receptacle" },
    aa_holder: { widthMm: 16.0, heightMm: 58.0, label: "single AA battery holder" },
    aaa_holder: { widthMm: 12.0, heightMm: 50.0, label: "single AAA battery holder" },
    "18650": { widthMm: 18.6, heightMm: 65.0, label: "18650 cell" },
    rj45: { widthMm: 16.5, heightMm: 13.5, label: "RJ45 jack" },
    hdmi: { widthMm: 14.0, heightMm: 6.0, label: "HDMI receptacle" },
    microsd: { widthMm: 14.0, heightMm: 15.0, label: "microSD slot" },
    pin_header_2_54: { widthMm: 2.54, heightMm: 2.54, label: "2.54 mm pin header pitch" },
  };

export function guessKnownPart(label: string): KnownScalePart | undefined {
  const t = label.toLowerCase();
  if (/\busb[-\s]?c\b/.test(t)) return "usb_c";
  if (/\busb[-\s]?a\b/.test(t)) return "usb_a";
  if (/\baa\b/.test(t) && /hold|batt/.test(t)) return "aa_holder";
  if (/\baaa\b/.test(t)) return "aaa_holder";
  if (/18650/.test(t)) return "18650";
  if (/rj45|ethernet/.test(t)) return "rj45";
  if (/hdmi/.test(t)) return "hdmi";
  if (/microsd|micro-sd/.test(t)) return "microsd";
  if (/2\.54|pin header|0\.1"/.test(t)) return "pin_header_2_54";
  return undefined;
}
