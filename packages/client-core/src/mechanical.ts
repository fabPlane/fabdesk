import { z } from "zod/v4";

export const MECHANICAL_LAYOUT_PATH = "cad/assembly-layout.json";
export const MODEL_MAX_BYTES = 50 * 1024 * 1024;
const vector = z.tuple([
  z.number().finite().min(-1e6).max(1e6),
  z.number().finite().min(-1e6).max(1e6),
  z.number().finite().min(-1e6).max(1e6),
]);
const path = z
  .string()
  .max(500)
  .refine(
    (p) =>
      !p.startsWith("/") && !p.includes("\\") && !p.includes(":") && !p.split("/").includes(".."),
  );
export const MechanicalItemSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  path,
  kind: z.enum(["board", "base", "lid", "import"]),
  position: vector,
  rotation: vector,
  scale: z.number().finite().positive().max(10000),
  visible: z.boolean(),
});
export const MechanicalLayoutSchema = z.object({
  version: z.literal(1),
  items: z.array(MechanicalItemSchema).max(100),
});
export type MechanicalItem = z.infer<typeof MechanicalItemSchema>;
export type MechanicalLayout = z.infer<typeof MechanicalLayoutSchema>;
/** Keep a generated case under the board's assembly transform, including rotation and scale. */
export function enclosurePose(
  board: MechanicalItem | undefined,
  mountHeight: number,
): Pick<MechanicalItem, "position" | "rotation" | "scale"> {
  if (!board) return { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const x = (board.rotation[0] * Math.PI) / 180,
    y = (board.rotation[1] * Math.PI) / 180,
    h = mountHeight * board.scale;
  return {
    position: [
      board.position[0] - Math.sin(y) * h,
      board.position[1] + Math.sin(x) * Math.cos(y) * h,
      board.position[2] - Math.cos(x) * Math.cos(y) * h,
    ],
    rotation: [...board.rotation],
    scale: board.scale,
  };
}
export function mechanicalItem(
  path: string,
  kind: MechanicalItem["kind"] = "import",
  name = path.split("/").at(-1)!,
): MechanicalItem {
  return {
    id: path,
    name,
    path,
    kind,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
    visible: true,
  };
}
export function modelFormat(name: string): "stl" | "obj" | "glb" | null {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return ext === "stl" || ext === "obj" || ext === "glb" ? ext : null;
}
export function validateModelFile(name: string, bytes: number) {
  if (!modelFormat(name))
    throw new Error("Choose an STL, OBJ or GLB model. STEP editing is available in Advanced CAD.");
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MODEL_MAX_BYTES)
    throw new Error("Choose a model between 1 byte and 50 MiB.");
}
export function parseMechanicalLayout(text: string): MechanicalLayout {
  const layout = MechanicalLayoutSchema.parse(JSON.parse(text));
  if (new Set(layout.items.map((i) => i.id)).size !== layout.items.length)
    throw new Error("Duplicate assembly model identities.");
  return layout;
}
