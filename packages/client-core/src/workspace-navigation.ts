/** Existing destinations, grouped without removing their tools or changing keyboard tab order. */
export const WORKSPACE_AREAS = {
  overview: { label: "Overview", views: [] },
  boards: { label: "Board", views: [{ tab: "pcb", label: "PCB" }, { tab: "schematic", label: "Schematic" }, { tab: "3d", label: "3D" }, { tab: "cinema", label: "Routing" }, { tab: "art", label: "Artwork" }] },
  mechanical: { label: "Mechanical", views: [{ tab: "cad", label: "Enclosure & CAD" }] },
  parts: { label: "Parts", views: [{ tab: "bom", label: "Parts & shopping" }] },
  outputs: { label: "Outputs", views: [{ tab: "renders", label: "Library" }, { tab: "3d", label: "Models & video" }, { tab: "files", label: "Export files" }] },
  review: { label: "Review", views: [{ tab: "updates", label: "Updates" }, { tab: "diff", label: "Changes" }, { tab: "comments", label: "Comments" }, { tab: "drc", label: "Checks" }] },
  files: { label: "Files", views: [{ tab: "files", label: "Files" }, { tab: "notes", label: "Notes" }] },
} as const;
export type WorkspaceArea = keyof typeof WORKSPACE_AREAS;
export type WorkspaceView = (typeof WORKSPACE_AREAS)[WorkspaceArea]["views"][number]["tab"];

export function workspaceAreaForView(view: string): WorkspaceArea {
  if (view === "cad") return "mechanical";
  if (view === "bom") return "parts";
  if (view === "renders") return "outputs";
  if (view === "updates" || view === "diff" || view === "comments" || view === "drc") return "review";
  if (view === "files" || view === "notes") return "files";
  return "boards";
}

export function workspaceViews(area: WorkspaceArea): ReadonlyArray<{ tab: WorkspaceView; label: string }> {
  return WORKSPACE_AREAS[area].views;
}

/** Restore only a tab actually offered by this area; older or malformed preferences use its default. */
export function workspaceTabForArea(area: WorkspaceArea, remembered: unknown): WorkspaceView | null {
  const views = workspaceViews(area);
  return views.find(view => view.tab === remembered)?.tab ?? views[0]?.tab ?? null;
}

/** Familiar task names remain searchable after their tools move into grouped workspaces. */
export function workspaceViewSearchTerms(area: WorkspaceArea, view: { tab: WorkspaceView; label: string }): string {
  const aliases: Partial<Record<`${WorkspaceArea}:${WorkspaceView}`, string>> = {
    "boards:pcb": "pcb layout placement position rotate resize board dimensions",
    "boards:schematic": "schematic circuit sheets",
    "boards:cinema": "route board router cinema playback",
    "parts:bom": "bill of materials bom parts shopping list off-board items quantities",
    "outputs:files": "export gerbers drill fabrication zip bom csv pick and place component placement dxf layers solder stencil laser cut lightburn download files",
    "outputs:renders": "render board renders images pictures saved outputs gallery",
    "outputs:3d": "3d glb stl obj model export download product video render make movie animation mp4 webm gif",
    "review:updates": "review updates sync freshness stale source changes",
    "review:drc": "run drc run erc electrical design rule checks findings",
    "review:diff": "diff changes compare revisions visual comparison history",
    "review:comments": "pin pins comments discussion questions answers",
    "files:notes": "project notes requirements decisions",
  };
  return `${WORKSPACE_AREAS[area].label} ${view.label} ${aliases[`${area}:${view.tab}`] ?? ""}`;
}
