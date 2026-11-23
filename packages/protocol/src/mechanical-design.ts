import { z } from "zod/v4";

const coordinate = z.number().finite().min(-10000).max(10000);
const size = z.number().finite().positive().max(2000);
const point = z.object({ x: coordinate, y: coordinate });
const edge = z.enum(["minX", "maxX", "minY", "maxY"]);
const dimensionEvidence = z.object({
  kind: z.enum(["estimate", "datasheet", "measured"]),
  reference: z.string().max(500).optional(),
});
const path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !/[\\:\0]/.test(p) && !p.startsWith("/") && !p.split("/").includes(".."),
    "Choose a file inside this project",
  );
export const MechanicalBoxSchema = z.object({
  name: z.string().min(1).max(80),
  x: coordinate,
  y: coordinate,
  z: coordinate,
  width: size,
  depth: size,
  height: size,
});
/**
 * [x, y, z] as a length-3 array typed as a tuple, not `z.tuple`: this schema is part of cad_fit's input, the MCP SDK
 * writes a tuple as array-form `items: [...]`, and Codex silently drops a tool whose schema has one.
 */
const vec3 = z.array(coordinate).length(3) as unknown as z.ZodType<[number, number, number]>;

export const MechanicalDesignSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["generated", "imported"]),
    confirmed: z.boolean(),
    source: z
      .object({
        path,
        scale: z.number().positive().max(10000),
        position: vec3,
        rotation: vec3,
      })
      .nullable(),
    space: z.object({
      x: coordinate,
      y: coordinate,
      width: size,
      depth: size,
      height: size,
      wall: z.number().min(0.5).max(20),
      floor: z.number().min(0.5).max(20),
      lid: z.number().min(0.5).max(20),
      clearance: z.number().min(0).max(20),
    }),
    boards: z
      .array(
        z.object({
          path,
          x: coordinate,
          y: coordinate,
          z: coordinate,
          rotation: z.number().finite().min(-360).max(360),
          locked: z.boolean().optional(),
        }),
      )
      .max(20),
    portAccess: z
      .array(
        z.object({
          boardPath: path,
          ref: z.string().min(1).max(500),
          access: z.enum(["external", "internal"]),
          face: edge.optional(),
          wall: edge.optional(),
          aperture: z
            .object({
              width: size,
              height: size,
              shape: z.enum(["rectangle", "rounded"]).optional(),
              evidence: dimensionEvidence.optional(),
            })
            .optional(),
          plug: z
            .object({
              width: size,
              height: size,
              depth: size,
              reach: z.number().finite().min(0).max(200),
              travel: z.number().finite().min(0).max(200).optional(),
              evidence: dimensionEvidence.optional(),
            })
            .optional(),
        }),
      )
      .max(500)
      .optional(),
    connections: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          from: z.object({ boardPath: path, ref: z.string().min(1).max(500) }),
          to: z.object({ boardPath: path, ref: z.string().min(1).max(500) }),
          length: size,
          slack: z.number().finite().min(0).max(1000),
          routing: z
            .object({
              diameter: z.number().finite().min(0.1).max(50),
              bendRadius: z.number().finite().min(0.1).max(100),
            })
            .optional(),
        }),
      )
      .max(100)
      .optional(),
    openingClearance: z.number().finite().min(0).max(5).optional(),
    /** Assumed maximum dimensional error per mating surface, not a printer certification. */
    fitAllowance: z.number().finite().min(0).max(0.5).optional(),
    detailedFit: z.boolean().optional(),
    assemblyCheck: z.boolean().optional(),
    layoutLimit: z.object({ width: size, depth: size }).optional(),
    closure: z
      .object({
        kind: z.enum(["lift-off", "screws"]),
        screwDiameter: z.number().min(1).max(6),
        screwLength: z.number().min(3).max(40),
        pilotDiameter: z.number().min(0.5).max(6),
        clearanceDiameter: z.number().min(1).max(8),
        bossDiameter: z.number().min(5).max(20),
      })
      .optional(),
    holders: z
      .array(z.object({ boardPath: path, kind: z.enum(["corner-clamps", "edge-clamps"]) }))
      .max(20)
      .refine(
        (items) => new Set(items.map((item) => item.boardPath)).size === items.length,
        "Choose one holder per board",
      )
      .optional(),
    obstacles: z.array(MechanicalBoxSchema).max(100),
    mounts: z
      .array(
        point
          .extend({
            diameter: z.number().min(0.5).max(20),
            outer: z.number().min(1).max(40),
            height: z.number().min(0.5).max(100),
            boardPath: path.optional(),
            holeId: z.string().min(1).max(500).optional(),
            headDiameter: z.number().min(0.5).max(40).optional(),
            headHeight: z.number().min(0.1).max(20).optional(),
            screwDiameter: z.number().min(0.5).max(20).optional(),
            screwLength: z.number().min(0.5).max(100).optional(),
          })
          .refine((m) => m.outer > m.diameter, "Mount diameter must leave a wall around the hole"),
      )
      .max(100),
    openings: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          shape: z.enum(["rectangle", "rounded"]).optional(),
          wall: z.enum(["minX", "maxX", "minY", "maxY"]),
          offset: coordinate,
          z: coordinate,
          width: size,
          height: size,
          boardPath: path.optional(),
          ref: z.string().min(1).max(500).optional(),
          followBoard: z.boolean().optional(),
        }),
      )
      .max(100),
  })
  .refine((d) => d.mode !== "imported" || d.source !== null, "Choose the enclosure file first")
  .refine((d) => {
    const paths = d.boards.map((b) =>
      b.path
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/"),
    );
    return new Set(paths).size === paths.length;
  }, "Include each PCB file only once in the enclosure");
export type MechanicalDesign = z.infer<typeof MechanicalDesignSchema>;
export function defaultConnectorAccess(footprint: string): "external" | "internal" {
  return /usb|hdmi|displayport|rj45|ethernet|audio|jack|barrel|micro.?sd|sd.?card|dm3|sma/i.test(
    footprint,
  )
    ? "external"
    : "internal";
}
export type MechanicalBox = z.infer<typeof MechanicalBoxSchema>;
export type PcbModelGap = {
  ref: string;
  footprint: string;
  reason: "unassigned" | "hidden" | "not-loaded" | "partial";
  /** Declared model paths, never interpreted as proof that geometry was loaded. */
  models: string[];
};
export type MechanicalFitIssue = {
  severity: "error" | "review";
  code: string;
  message: string;
  /** Affected conservative envelopes in the same world-mm frame as the design. */
  regions?: MechanicalBox[];
};
export type MechanicalFitReport = {
  /** Generated case and lid, including projecting hardware; millimetres. */
  outsideSize?: { width: number; depth: number; height: number };
  modelGaps?: Array<{ boardPath: string; parts: PcbModelGap[] }>;
  geometry?: { closed: boolean; baseParts: number; lidParts: number; engine: string };
  status: "blocked" | "review";
  issues: MechanicalFitIssue[];
  boardRevisions: Record<string, string>;
  checkedBoards: number;
  coverage: string;
};
export const MECHANICAL_DESIGN_PATH = "cad/enclosure-design.json";
