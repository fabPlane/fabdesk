export type Point = [number, number];
export type Ast = (string | Ast)[];
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface PlacementPart {
  id: string;
  ref: string;
  value: string;
  footprint: string;
  x: number;
  y: number;
  angle: number;
  originalAngle: number;
  side: "F" | "B";
  locked: boolean;
  group?: string;
  anchor?: { edge: "left" | "right" | "top" | "bottom"; offset: number };
  overhang?: boolean;
  bounds: Bounds;
  contours: Point[][];
  geometrySource: string;
  node: Ast;
  shapes: { type: string; layer: string; start: Point; end: Point; mid: Point; points: Point[] }[];
  pads: {
    number: string;
    type: string;
    shape: string;
    x: number;
    y: number;
    angle: number;
    w: number;
    h: number;
    drill: number;
    net: string;
    node: Ast;
  }[];
}
export interface PlacementSession {
  schema: string;
  name: string;
  root: Ast;
  parts: PlacementPart[];
  board: { x: number; y: number; w: number; h: number };
  outline: Ast[];
  outlineInferred: boolean;
  resized: boolean;
  contours?: Point[][];
  contourRoles?: string[];
  clearance: number;
  edgeClearance: number;
  spacingGuidelines: { enabled: boolean; courtyard: number; edge: number };
  reservedAreas?: {
    id: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    margin: number;
    side: "F" | "B" | "both";
  }[];
  netWeights?: Record<string, number>;
}
export interface PlacementFinding {
  ids: string[];
  kind: string;
  text: string;
  areaId?: string;
}
export interface NetEdge {
  name: string;
  a: { id: string; xy: Point };
  b: { id: string; xy: Point };
  length: number;
}
export interface PlacementReview {
  changed: { id: string; ref: string; from: number[] | null; to: number[] }[];
  added: PlacementFinding[];
  resolved: PlacementFinding[];
  remaining: number;
}
export interface PlacementAnalysis {
  findings: PlacementFinding[];
  guidelines: PlacementFinding[];
  edges: NetEdge[];
  length: number;
}
