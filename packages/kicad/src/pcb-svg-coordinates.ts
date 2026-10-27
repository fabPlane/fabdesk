import { PCB_SVG_COORDINATE_SYSTEM } from "@fabdesk/protocol";

/**
 * Crop a CURRENT-PAGE, unmirrored, scale-1 KiCad SVG without translating its geometry.
 * Never call this on a board-area SVG: that exporter rebases geometry to a new origin.
 */
export function cropNativePageSvg(svg: string, bounds?: { minX: number; minY: number; maxX: number; maxY: number }): string {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) throw new Error("KiCad did not return an SVG root.");
  const viewBox = root.match(/\bviewBox=["']([^"']+)["']/)?.[1]?.trim().split(/\s+/).map(Number);
  const width = root.match(/\bwidth=["']([-+\d.eE]+)mm["']/)?.[1];
  const height = root.match(/\bheight=["']([-+\d.eE]+)mm["']/)?.[1];
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[0] !== 0 || viewBox[1] !== 0 || !width || !height || Math.abs(Number(width) - viewBox[2]!) > .00001 || Math.abs(Number(height) - viewBox[3]!) > .00001) throw new Error("The SVG scale could not be verified as native PCB millimetres.");
  let next = root;
  if (bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) throw new Error("Invalid board preview bounds.");
    const margin = 2, w = maxX - minX + margin * 2, h = maxY - minY + margin * 2;
    next = next.replace(/\bwidth=["'][^"']*["']/, `width="${w}mm"`).replace(/\bheight=["'][^"']*["']/, `height="${h}mm"`).replace(/\bviewBox=["'][^"']*["']/, `viewBox="${minX - margin} ${minY - margin} ${w} ${h}"`);
  }
  next = next.replace(/>$/, ` data-fabplane-coordinate-system="${PCB_SVG_COORDINATE_SYSTEM}">`);
  return svg.replace(root, next);
}
