/** A native editable polyline uses millimetres, +Y up, and one closed point list per ring. */
type Point = [number, number];
type NativePath = { type: 1; points: Point[] };

// Accept only the SVG emitted by copperRemovalFromDxf. Every coordinate, including the
// page dimensions, is rounded to at most six decimals by the exporter. Refuse transforms,
// additional artwork and partial parses rather than changing the job's registration.
const number = String.raw`\d+(?:\.\d{1,6})?`;
const envelope = new RegExp(
  '^<svg xmlns="http://www\\.w3\\.org/2000/svg" width="(' + number + ')mm" height="(' + number + ')mm" viewBox="0 0 \\1 \\2">\\r?\\n'
  + '<title>Front copper to remove</title>\\r?\\n<path fill="#000000" fill-rule="evenodd" stroke="none" d="([^"]+)"/>\\r?\\n</svg>\\s*$',
);
const badArtwork = "This SVG does not match FabDesk’s front copper artwork. Prepare the board again.";

export function studioCopperGeometry(svg: string, options: { penIndex: number; fillParam: Record<string, unknown> }) {
  if (svg.length > 16 * 1024 * 1024) throw new Error("This artwork is too large for a native Studio project. Use Vector import.");
  const fields = envelope.exec(svg);
  if (!fields) throw new Error(badArtwork);
  const width = Number(fields[1]), height = Number(fields[2]), path = fields[3]!;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error(badArtwork);
  if (!Number.isSafeInteger(options.penIndex) || options.penIndex < 0) throw new Error("The Studio material is missing a valid pen.");

  const vertex = new RegExp('(?:([ML])(' + number + ') (' + number + ')|(Z))(?: |$)', 'y');
  const basePaths: NativePath[] = [];
  let ring: Point[] | undefined, twiceArea = 0, total = 0;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  while (vertex.lastIndex < path.length) {
    const match = vertex.exec(path);
    if (!match) throw new Error(badArtwork);
    if (match[4]) {
      if (!ring || ring.length < 3) throw new Error(badArtwork);
      const first = ring[0]!, last = ring[ring.length - 1]!;
      if ((first[0] === last[0] && first[1] === last[1])
        || twiceArea + last[0] * first[1] - first[0] * last[1] === 0) throw new Error(badArtwork);
      ring.push([...first]);
      basePaths.push({ type: 1, points: ring });
      ring = undefined;
      continue;
    }
    if (match[1] === "M") {
      if (ring) throw new Error(badArtwork);
      ring = [];
      twiceArea = 0;
    }
    const x = Number(match[2]), y = Number(match[3]);
    if (!ring || x > width || y > height) throw new Error(badArtwork);
    if (++total > 500_000) throw new Error("This artwork has too many vertices for a native Studio project. Use Vector import.");
    // Centre the physical PCB in Studio's field, including any blank margin outside the
    // engraving bounds. The input SVG is measured from the board's upper-left corner.
    const next: Point = [x - width / 2, height / 2 - y], previous = ring[ring.length - 1];
    if (previous) {
      if (previous[0] === next[0] && previous[1] === next[1]) throw new Error(badArtwork);
      twiceArea += previous[0] * next[1] - next[0] * previous[1];
    }
    ring.push(next);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (ring || !basePaths.length || minX >= maxX || minY >= maxY) throw new Error(badArtwork);

  // Fixed geometry defaults from a stock Studio type-4 polyline. "to" stores width
  // and height. Only the qualified pen and Fill settings come from the source project.
  return {
    type: 4 as const, name: "Front copper removal", basePaths, closed: false, arcRadius: 0,
    position: { from: [minX - width / 2, height / 2 - maxY], to: [maxX - minX, maxY - minY] },
    anchor: { type: 4, point: { x: 0, y: 0 } }, entityFlags: 0, penIndex: options.penIndex,
    rotatedAngle: 0, matrix: [1, 0, 0, 1, 0, 0], postTransformMatrix: [1, 0, 0, 1, 0, 0],
    fillParam: options.fillParam, userData: { variant: {} },
    arrayParam: {
      enabled: false, type: 0, disableSeriChange: false,
      rect: { flags: 0, rowCount: 2, colCount: 2, rowDistIncrease: 10, colDistIncrease: 10 },
      circular: { count: 1, radius: 10, clockwise: false, lockContentAngle: false, startAngle: 90, angleIncrease: 30 },
    },
  };
}
