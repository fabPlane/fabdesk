import type { MechanicalDesign } from "@fabdesk/protocol";

export type EnclosurePcbEdit =
  | { kind: "outline" }
  | { kind: "component"; reference: string; x: number; y: number }
  | { kind: "hole"; x: number; y: number; diameter: number };

/** PCB edits use native board coordinates; only rectangular sizing depends on placement. */
export function planEnclosurePcbEdit(design: MechanicalDesign, request: EnclosurePcbEdit) {
  if (!design.confirmed) throw new Error("Confirm the interior dimensions before editing the PCB.");
  const placement = design.boards.find((b) => b.path === "board.kicad_pcb");
  if (!placement) throw new Error("Add the project PCB to this enclosure first.");
  if (request.kind !== "outline") {
    if (![request.x, request.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 10000))
      throw new Error("Enter valid PCB coordinates between −10000 and 10000 mm.");
    if (request.kind === "component") {
      if (!request.reference.trim()) throw new Error("Choose a component first.");
      return {
        footprints: [{ reference: request.reference, position: { x: request.x, y: request.y } }],
      };
    }
    if (!Number.isFinite(request.diameter) || request.diameter < 0.5 || request.diameter > 20)
      throw new Error("Use a PCB hole diameter from 0.5 to 20 mm.");
    return { holes: [{ x: request.x, y: request.y, diameter: request.diameter }] };
  }
  if (placement.rotation !== 0)
    throw new Error("Set the project PCB rotation to 0° before sizing its rectangular outline.");
  const s = design.space,
    c = s.clearance;
  const x = s.x + c - placement.x,
    y = s.y + c - placement.y;
  const width = s.width - 2 * c,
    height = s.depth - 2 * c;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error("The interior must be wider and deeper than twice the required clearance.");
  return {
    outline: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  };
}
