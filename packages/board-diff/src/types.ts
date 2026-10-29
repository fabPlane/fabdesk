/** A board, schematic, or netlist snapshot used as one side of a revision diff. */

export type Point = { x: number; y: number };

export type NetNode = {
  ref: string;
  pin: string;
};

export type PadSnapshot = {
  pin: string;
  shape?: string;
  width?: number;
  height?: number;
  drill?: number;
  net?: string;
};

export type ComponentSnapshot = {
  ref: string;
  value?: string;
  footprint?: string;
  libId?: string;
  x?: number;
  y?: number;
  rotation?: number;
  layer?: string;
  schX?: number;
  schY?: number;
  schRotation?: number;
  pads?: PadSnapshot[];
};

export type NetSnapshot = {
  name: string;
  code?: number;
  nodes: NetNode[];
};

export type TrackSnapshot = {
  id: string;
  start: Point;
  end: Point;
  width: number;
  layer: string;
  net?: string;
  /** Flattened polyline for arcs; omitted for straight segments. */
  points?: Point[];
};

export type ViaSnapshot = {
  id: string;
  x: number;
  y: number;
  diameter: number;
  drill: number;
  net?: string;
};

export type ZoneSnapshot = {
  id: string;
  points: Point[];
  layers: string[];
  net?: string;
};

export type BoardSnapshot = {
  components: ComponentSnapshot[];
  nets: NetSnapshot[];
  tracks: TrackSnapshot[];
  vias: ViaSnapshot[];
  zones: ZoneSnapshot[];
  outline: Point[];
  /** Separate native Edge.Cuts paths; points alone do not imply connected polygon vertices. */
  outlinePaths?: Point[][];
};

export type ComponentChangeReason =
  | "moved"
  | "rotated"
  | "layer"
  | "value"
  | "footprint"
  | "pads"
  | "schematic-moved"
  | "schematic-rotated";

export type ComponentChange = {
  ref: string;
  before: ComponentSnapshot;
  after: ComponentSnapshot;
  reasons: ComponentChangeReason[];
  dx?: number;
  dy?: number;
  /** Schematic placement delta, set with `schematic-moved`. */
  schDx?: number;
  schDy?: number;
};

export type NetChange = {
  name: string;
  before: NetSnapshot;
  after: NetSnapshot;
  addedNodes: NetNode[];
  removedNodes: NetNode[];
};

export type ViaChangeReason = "moved" | "resized" | "net";

export type ViaChange = {
  before: ViaSnapshot;
  after: ViaSnapshot;
  reasons: ViaChangeReason[];
  dx?: number;
  dy?: number;
};

export type ZoneChangeReason = "reshaped" | "net" | "layers";

export type ZoneChange = {
  before: ZoneSnapshot;
  after: ZoneSnapshot;
  reasons: ZoneChangeReason[];
};

export type BoardDiff = {
  components: {
    added: ComponentSnapshot[];
    removed: ComponentSnapshot[];
    changed: ComponentChange[];
    unchanged: string[];
  };
  nets: {
    added: NetSnapshot[];
    removed: NetSnapshot[];
    changed: NetChange[];
    unchanged: string[];
  };
  tracks: {
    added: TrackSnapshot[];
    removed: TrackSnapshot[];
    unchanged: number;
  };
  vias: {
    added: ViaSnapshot[];
    removed: ViaSnapshot[];
    changed: ViaChange[];
    unchanged: number;
  };
  zones: {
    added: ZoneSnapshot[];
    removed: ZoneSnapshot[];
    changed: ZoneChange[];
    unchanged: number;
  };
};

export type DiffOptions = {
  /** PCB movement below this (mm) is treated as unchanged. Default 0.05. */
  moveToleranceMm?: number;
  /** Schematic movement below this (sheet mm) is treated as unchanged. Default 0.05. */
  schematicMoveToleranceMm?: number;
  /** Rotation delta below this (degrees) is treated as unchanged. Default 0.5. */
  rotationToleranceDeg?: number;
};

export function emptySnapshot(): BoardSnapshot {
  return { components: [], nets: [], tracks: [], vias: [], zones: [], outline: [] };
}

export function nodeKey(node: NetNode): string {
  return `${node.ref}.${node.pin}`;
}
