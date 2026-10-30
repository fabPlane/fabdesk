import type { MechanicalDesign } from "@fabdesk/protocol";
import {
  proposeEnclosureLayout,
  type EnclosureLayoutGoal,
  type LayoutBoard,
} from "./enclosure-layout";

/** Do not offer exported snapshots as extra boards. Existing selections remain removable. */
export function enclosureSourceBoards(files: string[], selected: string[]) {
  return [
    ...new Set([
      ...selected,
      ...files.filter(
        (path) =>
          /\.kicad_pcb$/i.test(path) &&
          !/(^|[/\\])(exports|node_modules|vendor|\.git)([/\\]|$)/i.test(path),
      ),
    ]),
  ].sort((a, b) => a.localeCompare(b));
}

export function selectEnclosureBoards(design: MechanicalDesign, paths: string[]): MechanicalDesign {
  const selected = new Set(paths);
  if (selected.size > 20) throw Error("Choose up to 20 boards for one case.");
  return {
    ...design,
    boards: [...selected].map(
      (path) =>
        design.boards.find((b) => b.path === path) ?? {
          path,
          x: 0,
          y: 0,
          z: design.space.floor + 3,
          rotation: 0,
        },
    ),
    mounts: design.mounts.filter((m) => !m.boardPath || selected.has(m.boardPath)),
    ...(design.holders ? { holders: design.holders.filter((h) => selected.has(h.boardPath)) } : {}),
    openings: design.openings.filter((o) => !o.boardPath || selected.has(o.boardPath)),
    ...(design.portAccess
      ? { portAccess: design.portAccess.filter((p) => selected.has(p.boardPath)) }
      : {}),
    ...(design.connections
      ? {
          connections: design.connections.filter(
            (c) => selected.has(c.from.boardPath) && selected.has(c.to.boardPath),
          ),
        }
      : {}),
  };
}

/** Generated dimensions are calculated, not represented as measured physical confirmation. */
export function prepareEnclosurePreview(
  design: MechanicalDesign,
  boards: LayoutBoard[],
  layout: EnclosureLayoutGoal | "keep",
): MechanicalDesign {
  if (!design.boards.length) throw Error("Choose at least one board first.");
  if (design.mode === "imported") {
    if (!design.source?.path) throw Error("Choose an existing case file first.");
    if (!design.confirmed) throw Error("Check the inside dimensions of your existing case first.");
    return design;
  }
  const ready = { ...design, confirmed: true };
  return layout === "keep" ? ready : proposeEnclosureLayout(ready, boards, layout).design;
}
