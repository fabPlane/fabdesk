/**
 * LightBurn .lbrn2 writer for laser-cut paste stencils.
 * Compact VertList/PrimList geometry plus CutSetting starting-point values.
 */
import type { LaserCutPath, LaserJobSettings, LaserStencilBuild } from "./stencil-laser";
import type { Vec2 } from "./stencil";

const LAYER_INDEX = {
  APERTURES: 0,
  FRAME: 1,
  FIDUCIALS: 2,
  GUIDE: 3,
} as const;

const LAYER_PRIORITY = {
  APERTURES: 0,
  FRAME: 1,
  FIDUCIALS: 2,
  GUIDE: 3,
} as const;

export function laserStencilLbrn2(built: LaserStencilBuild): string {
  const { frame, paths, job } = built;
  const tx = (x: number) => x - frame.minX;
  const ty = (y: number) => frame.maxY - y;
  const shapes: string[] = [];
  for (const path of paths) {
    const cutIndex = LAYER_INDEX[path.layer];
    if (path.kind === "circle" && path.x != null && path.y != null && path.radiusMm != null) {
      shapes.push(ellipseShape(cutIndex, tx(path.x), ty(path.y), path.radiusMm));
      continue;
    }
    const pts = path.points;
    if (!pts || pts.length < 2) continue;
    shapes.push(pathShape(cutIndex, pts.map(([x, y]) => [tx(x), ty(y)])));
  }
  const cutLayers: Array<{
    name: LaserCutPath["layer"];
    cut: boolean;
    job: LaserJobSettings;
  }> = [
    { name: "APERTURES", cut: true, job },
    { name: "FRAME", cut: true, job },
    { name: "FIDUCIALS", cut: true, job },
    { name: "GUIDE", cut: false, job },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<LightBurnProject AppVersion="1.7.04" FormatVersion="1" MaterialHeight="${fmt(built.layout.options.thicknessMm)}" MirrorX="False" MirrorY="True">
${cutLayers.map((layer) => cutSetting(layer)).join("\n")}
<!-- Starting-point job for ${escapeXml(built.preset.title)}. Edit power/speed/frequency/passes in LightBurn after a coupon test. -->
${shapes.join("\n")}
</LightBurnProject>
`;
}

function cutSetting(layer: { name: LaserCutPath["layer"]; cut: boolean; job: LaserJobSettings }): string {
  const index = LAYER_INDEX[layer.name];
  const job = layer.job;
  const fields: Array<[string, string | number]> = [
    ["index", index],
    ["name", layer.name],
    ["minPower", job.powerPct],
    ["maxPower", job.powerPct],
    ["minPower2", 0],
    ["maxPower2", 0],
    ["speed", job.speedMmPerS],
    ["kerf", 0],
    ["zOffset", 0],
    ["enableLaser1", 1],
    ["enableLaser2", 0],
    ["priority", LAYER_PRIORITY[layer.name]],
    ["frequency", Math.round(job.frequencyKhz * 1000)],
    ["overrideFrequency", 1],
    ["QPulseWidth", job.pulseNs],
    ["doOutput", layer.cut ? 1 : 0],
    ["hide", 0],
    ["numPasses", job.passes],
    ["zPerPass", 0],
    ["scanOpt", "mergeAll"],
    ["bidir", 1],
    ["interval", 0.03],
    ["angle", 0],
  ];
  const body = fields.map(([k, v]) => `    <${k} Value="${escapeXml(String(v))}"/>`).join("\n");
  return `  <CutSetting type="Cut">
${body}
  </CutSetting>`;
}

function pathShape(cutIndex: number, pts: Vec2[]): string {
  const closed = isClosed(pts);
  const verts = closed ? pts.slice(0, -1) : pts;
  if (verts.length < 2) return "";
  const vertList = verts.map(([x, y]) => `V${fmt(x)} ${fmt(y)}`).join("");
  const prims: string[] = [];
  for (let i = 0; i < verts.length - 1; i++) prims.push(`L${i} ${i + 1}`);
  if (closed || verts.length >= 3) prims.push(`L${verts.length - 1} 0`);
  return `  <Shape Type="Path" CutIndex="${cutIndex}">
    <XForm>1 0 0 1 0 0</XForm>
    <VertList>${vertList}</VertList>
    <PrimList>${prims.join("")}</PrimList>
  </Shape>`;
}

function ellipseShape(cutIndex: number, x: number, y: number, r: number): string {
  return `  <Shape Type="Ellipse" CutIndex="${cutIndex}" Rx="${fmt(r)}" Ry="${fmt(r)}">
    <XForm>1 0 0 1 ${fmt(x)} ${fmt(y)}</XForm>
  </Shape>`;
}

function isClosed(pts: Vec2[]): boolean {
  const last = pts.at(-1);
  const first = pts[0];
  return (
    pts.length >= 2 &&
    last !== undefined &&
    first !== undefined &&
    last[0] === first[0] &&
    last[1] === first[1]
  );
}

function fmt(n: number): string {
  return n.toFixed(5).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
