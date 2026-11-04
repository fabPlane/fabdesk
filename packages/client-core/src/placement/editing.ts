import { children, val, parse, partFromNode, renewFootprintIds, expanded } from "./engine";
import type { PlacementSession, PlacementPart, Point } from "./types";

export function setPartValue(part: PlacementPart, value: string) {
  part.value = value;
  const prop = children(part.node, "property").find((n) => val(n[1]) === "Value");
  if (prop) prop[2] = JSON.stringify(value);
  else part.node.push(["property", '"Value"', JSON.stringify(value)]);
}
export function swapPlacement(session: PlacementSession, aId: string, bId: string) {
  const a = session.parts.find((p) => p.id === aId),
    b = session.parts.find((p) => p.id === bId);
  if (!a || !b || a === b || [a, b].some((p) => p.locked || p.anchor || p.group))
    throw new Error("Choose two unlocked, unanchored individual components.");
  [a.x, b.x] = [b.x, a.x];
  [a.y, b.y] = [b.y, a.y];
  [a.angle, b.angle] = [b.angle, a.angle];
}
export function setAnchorOffset(session: PlacementSession, id: string, offset: number) {
  const p = session.parts.find((p) => p.id === id);
  if (!p?.anchor || !Number.isFinite(offset) || Math.abs(offset) > 2000)
    throw new Error("Invalid anchor offset.");
  const ids = new Set(expanded(session, [id]));
  if (session.parts.some((p) => ids.has(p.id) && p.locked))
    throw new Error("Unlock this group first.");
  const axis = ["left", "right"].includes(p.anchor.edge) ? "x" : "y",
    delta = offset - p.anchor.offset;
  if (
    session.parts.some(
      (q) =>
        q.id !== id &&
        ids.has(q.id) &&
        q.anchor &&
        (["left", "right"].includes(q.anchor.edge) ? "x" : "y") === axis,
    )
  )
    throw new Error(
      "Another edge anchor fixes this group's position. Unanchor it before changing this offset.",
    );
  p.anchor.offset = offset;
  for (const q of session.parts) if (ids.has(q.id)) q[axis] += delta;
}
export function addPlacementFootprint(
  session: PlacementSession,
  text: string,
  name: string,
  at?: Point,
) {
  if (session.parts.length >= 1500) throw new Error("Placement supports up to 1,500 components.");
  const node = parse(text);
  if (node[0] !== "footprint") throw new Error("Open a KiCad footprint.");
  // Added library parts have no schematic or electrical connections.
  for (const pad of children(node, "pad"))
    for (let i = pad.length - 1; i >= 0; i--)
      if (Array.isArray(pad[i]) && (pad[i] as string[])[0] === "net") pad.splice(i, 1);
  renewFootprintIds(node);
  const part = partFromNode(node, session.parts.length),
    prefix = name.startsWith("Resistor")
      ? "R"
      : name.startsWith("Capacitor")
        ? "C"
        : name.startsWith("MountingHole")
          ? "H"
          : name.startsWith("Connector")
            ? "J"
            : "U";
  let n = 1;
  while (session.parts.some((p) => p.ref === prefix + n)) n++;
  part.id = crypto.randomUUID();
  part.ref = prefix + n;
  part.footprint = name;
  part.value = part.value || "";
  part.node[1] = JSON.stringify(name);
  const ref = children(node, "property").find((p) => val(p[1]) === "Reference");
  if (ref) ref[2] = JSON.stringify(part.ref);
  else node.push(["property", '"Reference"', JSON.stringify(part.ref)]);
  part.x = at?.[0] ?? session.board.x + session.board.w / 2;
  part.y = at?.[1] ?? session.board.y + session.board.h / 2;
  session.parts.push(part);
  return part;
}
