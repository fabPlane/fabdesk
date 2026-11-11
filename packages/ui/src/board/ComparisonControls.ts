import { createContext } from "react";

/** Keep per-view actions beside the pane title instead of repeating the shared selector. */
export const ComparisonControls = createContext<{ target: HTMLDivElement | null; label: string } | null>(null);
