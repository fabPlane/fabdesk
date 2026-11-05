import { z } from "zod/v4";

/** Git-tracked cross-board part links. A link records intent for inspection, not electrical proof. */
export const PART_LINKS_FILE = "fabplane.connections.json";
export const PART_LINKS_CONTRACT = "fabplane.part-links.v1";
const PcbPath = z.string().min(1).max(500).refine(
  (path) => /\.kicad_pcb$/i.test(path) && !/[\\:\0]/.test(path) && !path.startsWith("/") && !path.split("/").includes(".."),
  "Choose a .kicad_pcb file inside this project",
);
export const PartEndpoint = z.object({ boardPath: PcbPath, ref: z.string().min(1).max(120) }).strict();
export type PartEndpoint = z.infer<typeof PartEndpoint>;
/** What an endpoint looked like when it was linked or last reviewed, in outline coordinates. */
export const PartBaseline = z.object({
  footprint: z.string().max(500).optional(),
  layer: z.string().max(40).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  rotation: z.number().finite().optional(),
  pads: z.array(z.string().max(300)).max(2000),
}).strict();
export type PartBaseline = z.infer<typeof PartBaseline>;
/** Which pin on end a goes to which pin on end b, as a person or agent stated it. */
export const PartPinPair = z.object({ a: z.string().min(1).max(120), b: z.string().min(1).max(120) }).strict();
export type PartPinPair = z.infer<typeof PartPinPair>;
export const PartLink = z.object({
  id: z.string().regex(/^lnk_[a-f0-9]{12}$/),
  a: PartEndpoint,
  b: PartEndpoint,
  name: z.string().max(160).optional(),
  note: z.string().max(2000).optional(),
  pins: z.array(PartPinPair).max(2000).optional(),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime(),
  baseline: z.object({ a: PartBaseline, b: PartBaseline }).strict(),
}).strict();
export type PartLink = z.infer<typeof PartLink>;
export const PartLinksFile = z.object({
  contract: z.literal(PART_LINKS_CONTRACT),
  links: z.array(PartLink).max(1000),
}).strict();
export type PartLinksFile = z.infer<typeof PartLinksFile>;
export const emptyPartLinksFile = (): PartLinksFile => ({ contract: PART_LINKS_CONTRACT, links: [] });

export type BoardFile = { path: string; name: string; bytes?: number };
export type BoardPartSummary = {
  ref: string;
  value?: string;
  footprint?: string;
  layer?: string;
  x: number;
  y: number;
  rotation?: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  nets: string[];
  pads: Array<{ pin: string; net?: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }>;
};
export type BoardRevisionKind = "worktree" | "git" | "saved" | "export";
export type BoardChangeCounts = { added: number; removed: number; moved: number; changed: number; renamed: number; unchanged: number };
export type BoardTimelineEntry = {
  ref: string;
  kind: BoardRevisionKind;
  title: string;
  date?: string;
  sha256: string;
  parts: number;
  size: { width: number; height: number } | null;
  /** Changes from the entry before this one; absent on the oldest entry. */
  changes?: BoardChangeCounts;
};
export type BoardTimeline = { pcbPath: string; entries: BoardTimelineEntry[]; git: boolean; truncated: boolean };
export type BoardPartChangeRow = {
  kind: "added" | "removed" | "moved" | "changed" | "renamed";
  fromRef?: string;
  toRef?: string;
  value?: string;
  footprint?: string;
  reasons: string[];
  dx?: number;
  dy?: number;
  distance?: number;
};
export type BoardRevisionSide = {
  ref: string;
  label: string;
  sha256: string;
  size: { width: number; height: number } | null;
  parts: BoardPartSummary[];
  drawing?: string;
};
export type PartLinkImpact = { linkId: string; changedRef: string; change: BoardPartChangeRow["kind"]; peer: PartEndpoint };
export type BoardRevisionComparison = {
  pcbPath: string;
  from: BoardRevisionSide;
  to: BoardRevisionSide;
  summary: BoardChangeCounts;
  changes: BoardPartChangeRow[];
  nets: { added: number; removed: number; changed: number };
  copper: { tracksAdded: number; tracksRemoved: number };
  impacts: PartLinkImpact[];
};
export type BoardView = { pcbPath: string; label: string; sha256: string; size: { width: number; height: number } | null; parts: BoardPartSummary[]; drawing?: string };
export type PartLinkState = "current" | "needs-review" | "missing";
export type SharedNet = { net: string; aPin: string; bPin: string };
export type ResolvedPartLink = PartLink & { state: PartLinkState; reasons: string[]; sharedNets: SharedNet[] };
/** A connection declared elsewhere: read-only here, owned by its enclosure design or assembly manifest. */
export type DeclaredConnection = { id: string; source: "mechanical" | "assembly"; name?: string; a: PartEndpoint; b: PartEndpoint };
export type PartLinkList = { links: ResolvedPartLink[]; declared: DeclaredConnection[] };
export type PartLinkSuggestion = { a: PartEndpoint; b: PartEndpoint; sharedNets: SharedNet[]; connectors: boolean };
