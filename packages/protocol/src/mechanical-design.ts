import { z } from "zod/v4";

const coordinate = z.number().finite().min(-10000).max(10000);
const size = z.number().finite().positive().max(2000);
const point = z.object({ x: coordinate, y: coordinate });
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
export const MechanicalDesignSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["generated", "imported"]),
    confirmed: z.boolean(),
    source: z
      .object({
        path,
        scale: z.number().positive().max(10000),
        position: z.tuple([coordinate, coordinate, coordinate]),
        rotation: z.tuple([coordinate, coordinate, coordinate]),
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
        }),
      )
      .max(20),
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
          wall: z.enum(["minX", "maxX", "minY", "maxY"]),
          offset: coordinate,
          z: coordinate,
          width: size,
          height: size,
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
export type MechanicalBox = z.infer<typeof MechanicalBoxSchema>;
export type MechanicalFitIssue = {
  severity: "error" | "review";
  code: string;
  message: string;
  /** Affected conservative envelopes in the same world-mm frame as the design. */
  regions?: MechanicalBox[];
};
export type MechanicalFitReport = {
  status: "blocked" | "review";
  issues: MechanicalFitIssue[];
  boardRevisions: Record<string, string>;
  checkedBoards: number;
  coverage: string;
};
export const MECHANICAL_DESIGN_PATH = "cad/enclosure-design.json";
