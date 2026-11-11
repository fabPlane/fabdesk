import { createContext } from "react";

export type ComparisonView = "pcb" | "schematic" | "3d";
export type ComparisonFocus = { id: number; ref: string; origin: ComparisonView | null };
/** Keep per-view actions beside the pane title and broadcast explicit selection gestures. */
export const ComparisonControls = createContext<{
  target: HTMLDivElement | null;
  label: string;
  view: ComparisonView;
  focus: ComparisonFocus | null;
  onSelect: (ref: string, origin: ComparisonView) => void;
} | null>(null);
