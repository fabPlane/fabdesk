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

export type BoardPartStatus = "new" | "changed" | "existing";
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
  /** A connector by reference or footprint, so people and agents can find where boards join. */
  connector: boolean;
  /** Against the previous revision of this board, when there is one. */
  status?: BoardPartStatus;
  /** Parts this one is linked to, on any board. */
  linkedTo?: PartEndpoint[];
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
export type BoardView = {
  pcbPath: string;
  label: string;
  sha256: string;
  size: { width: number; height: number } | null;
  parts: BoardPartSummary[];
  /** The revision that part status is measured against; absent with no earlier revision. */
  baseline?: { ref: string; label: string };
  drawing?: string;
};
export type PartLinkState = "current" | "needs-review" | "missing";
export type SharedNet = { net: string; aPin: string; bPin: string };
export type ResolvedPartLink = PartLink & { state: PartLinkState; reasons: string[]; sharedNets: SharedNet[]; check: PinCheck };
/** A connection declared elsewhere: read-only here, owned by its enclosure design or assembly manifest. */
export type DeclaredConnection = { id: string; source: "mechanical" | "assembly"; name?: string; a: PartEndpoint; b: PartEndpoint };
export type PartLinkList = { links: ResolvedPartLink[]; declared: DeclaredConnection[] };
export type PartLinkSuggestion = { a: PartEndpoint; b: PartEndpoint; sharedNets: SharedNet[]; connectors: boolean };

const CONNECTOR_REF = /^(?:J|P|CN|CON|X|FPC|USB|HDMI)\d/i;
const CONNECTOR_FOOTPRINT = /(?:^|[:_/ ])(?:connector|conn|header|socket|fpc|ffc|usb|hdmi|jst)(?:[:_/ -]|$)/i;

export function isConnectorPart(ref: string, footprint?: string): boolean {
  return CONNECTOR_REF.test(ref) || (!!footprint && CONNECTOR_FOOTPRINT.test(footprint));
}

export type PinCheckKind = "match" | "differs" | "conflict" | "unnamed";
export type PinCheckRow = { a: string; b: string; aNet?: string; bNet?: string; kind: PinCheckKind };
export type PinCheck = {
  /** No pins stated, all agree by name, something to look at, or a likely wiring error. */
  status: "none" | "agree" | "review" | "conflict";
  rows: PinCheckRow[];
  /** Pins on end a with a named net that the map leaves out. */
  unmapped: string[];
};
type PinPad = { pin: string; net?: string | undefined };

const GENERATED_NET = /^(?:Net-\(|unconnected-|N\$)/;
const GROUND_NET = /^(?:[ADPS]?GND\w*|VSS\w*|EARTH\w*|0V)$/i;
/** Voltages are written +3V3, +3.3V, 3.3V, -12V or +1V8; 0V is a ground. */
const POWER_NET = /^(?:(?!0V$)[+-]?\d+(?:\.\d+)?V\d*\w*|[+-]?V(?:CC|DD|BUS|BAT|IN|SYS|IO)\w*)$/i;
/** Hierarchical sheets prefix net names; the same signal keeps its last segment. */
export const netName = (net: string) => net.split("/").at(-1) ?? net;
/** KiCad's generated names repeat one board's own reference, so they say nothing across boards. */
export const isGeneratedNet = (net?: string): boolean => !net || GENERATED_NET.test(net) || !netName(net);
/** The comparable name of a net, or undefined when it has none. Boards name one signal with or without a sheet prefix. */
export const namedNet = (net?: string): string | undefined => (net && !isGeneratedNet(net) ? netName(net) : undefined);

/** Ground and power rails reach most parts on a board, so a shared rail says little by itself. */
export function isRailNet(net: string): boolean {
  const name = netName(net);
  return GROUND_NET.test(name) || POWER_NET.test(name);
}

function pinKind(aNet?: string, bNet?: string): PinCheckKind {
  const a = namedNet(aNet), b = namedNet(bNet);
  if (!a || !b) return "unnamed";
  // Boards differ in capitalisation more often than they mean two different nets.
  if (a.toLowerCase() === b.toLowerCase()) return "match";
  const ground = (net: string) => GROUND_NET.test(net), power = (net: string) => POWER_NET.test(net);
  // Different rails joined by a cable are the mistake worth stopping for.
  if ((ground(a) && power(b)) || (power(a) && ground(b)) || (power(a) && power(b))) return "conflict";
  return "differs";
}

/**
 * Compare a stated pin map against net names on both parts. This reads names only: agreement is a
 * good sign, not proof, since boards can name one signal differently or reuse a name for another.
 */
export function checkPinMap(aPads: readonly PinPad[] | undefined, bPads: readonly PinPad[] | undefined, pins: readonly PartPinPair[] | undefined): PinCheck {
  const netOf = (pads: readonly PinPad[] | undefined, pin: string) => pads?.find((pad) => pad.pin === pin)?.net;
  const rows = (pins ?? []).map((pair): PinCheckRow => {
    const aNet = netOf(aPads, pair.a), bNet = netOf(bPads, pair.b);
    return { a: pair.a, b: pair.b, ...(aNet ? { aNet } : {}), ...(bNet ? { bNet } : {}), kind: pinKind(aNet, bNet) };
  });
  const mapped = new Set(rows.map((row) => row.a));
  const unmapped = [...new Set((aPads ?? []).filter((pad) => !mapped.has(pad.pin) && namedNet(pad.net)).map((pad) => pad.pin))];
  const status: PinCheck["status"] = !rows.length ? "none" : rows.some((row) => row.kind === "conflict") ? "conflict" : rows.some((row) => row.kind !== "match") || unmapped.length ? "review" : "agree";
  return { status, rows, unmapped };
}
