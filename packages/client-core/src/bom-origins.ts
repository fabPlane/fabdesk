import type { ProjectBomSnapshot } from "@fabdesk/protocol";

/** Design coverage counts physical instances; it never substitutes for supplier stock or checks. */
export function bomOrigins(snapshot: ProjectBomSnapshot) {
  const included = snapshot.coverage.filter(source => source.multiplier > 0);
  const read = included.filter(source => source.status === "native-schematic" || source.status === "saved-netlist");
  const attention = included.filter(source => source.status !== "native-schematic");
  return {
    boards: included.reduce((sum, source) => sum + source.multiplier, 0),
    designs: included.length,
    readDesigns: read.length,
    attention: attention.length,
    mountedParts: snapshot.lines.filter(line => line.kind === "pcb").reduce((sum, line) => sum + line.qty, 0),
    hardwareParts: snapshot.lines.filter(line => line.kind !== "pcb").reduce((sum, line) => sum + line.qty, 0),
    lines: snapshot.lines.length,
  };
}
