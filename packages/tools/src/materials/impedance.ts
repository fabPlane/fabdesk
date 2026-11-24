/** Closed-form IPC-2141-style microstrip widths from Dk, height, and copper thickness. */

export function microstripWidthMm(opts: {
  z0: number;
  er: number;
  heightMm: number;
  copperMm?: number;
}): number {
  const t = opts.copperMm ?? 0.035;
  const h = Math.max(opts.heightMm, 0.02);
  const er = Math.max(opts.er, 1.1);
  const z0 = Math.max(opts.z0, 1);
  const inner = (5.98 * h) / Math.exp((z0 * Math.sqrt(er + 1.41)) / 87) - t;
  return Math.max(inner / 0.8, 0.05);
}

export function microstripZ0(opts: {
  widthMm: number;
  er: number;
  heightMm: number;
  copperMm?: number;
}): number {
  const t = opts.copperMm ?? 0.035;
  const h = Math.max(opts.heightMm, 0.02);
  const w = Math.max(opts.widthMm, 0.02);
  const er = Math.max(opts.er, 1.1);
  return (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + t));
}

/** Coupled-microstrip odd-mode approximation: Zdiff ≈ 2 Z0 (1 − 0.48 exp(−0.96 s/h)). */
export function differentialWidthMm(opts: {
  zDiff: number;
  er: number;
  heightMm: number;
  copperMm?: number;
  gapToWidth?: number;
}): { widthMm: number; gapMm: number } {
  const ratio = opts.gapToWidth ?? 1;
  const h = Math.max(opts.heightMm, 0.02);
  const copper = opts.copperMm !== undefined ? { copperMm: opts.copperMm } : {};
  let width = microstripWidthMm({ z0: opts.zDiff / 2, er: opts.er, heightMm: h, ...copper });
  for (let i = 0; i < 8; i++) {
    const gap = Math.max(width * ratio, 0.05);
    const couple = 1 - 0.48 * Math.exp(-0.96 * (gap / h));
    const z0 = opts.zDiff / (2 * Math.max(couple, 0.2));
    width = microstripWidthMm({ z0, er: opts.er, heightMm: h, ...copper });
  }
  return { widthMm: round3(width), gapMm: round3(Math.max(width * ratio, 0.05)) };
}

export function firstDielectric(layers: Array<{ kind: string; er?: number; tand?: number; thicknessMm: number }>): {
  heightMm: number;
  er: number;
  tand: number;
} {
  const d = layers.find((l) => l.kind === "dielectric" || l.kind === "coverlay");
  return {
    heightMm: d?.thicknessMm ?? 0.2,
    er: d?.er && d.er > 1 ? d.er : 4.5,
    tand: d?.tand !== undefined && d.tand >= 0 ? d.tand : 0.02,
  };
}

export function firstCopperMm(layers: Array<{ kind: string; thicknessMm: number }>): number {
  return layers.find((l) => l.kind === "copper")?.thicknessMm ?? 0.035;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
