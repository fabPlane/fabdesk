import { z } from "zod/v4";

/** Artwork is owned by a project root board; assembly source editing is a separate capability. */
export const BoardArtworkSettings = z.object({
  style: z.enum(["realistic", "retro", "poster"]),
  color: z.enum(["green", "black", "blue", "red", "purple", "white", "yellow"]),
  colorMode: z.enum(["monotone", "multicolor"]).optional(),
  recolor: z.object({
    mode: z.enum(["original", "grayscale", "duotone"]),
    amount: z.number().finite().min(0).max(1),
    shadow: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).optional(),
  printedBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  inkColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  crop: z.enum(["none", "circle", "rounded"]),
  outline: z.enum(["rectangle", "rounded", "circle"]),
  widthMm: z.number().finite().positive().max(400),
  heightMm: z.number().finite().positive().max(400),
  invert: z.boolean(),
  threshold: z.number().finite().min(0).max(1),
  layers: z.array(z.enum(["silk", "mask", "copper"])).min(1).max(3),
  placement: z.object({
    centerXmm: z.number().finite(), centerYmm: z.number().finite(),
    widthMm: z.number().finite().positive().max(800), heightMm: z.number().finite().positive().max(800),
    rotationDeg: z.number().finite(),
  }).nullable(),
  lockProportions: z.boolean(),
});
export type BoardArtworkSettings = z.infer<typeof BoardArtworkSettings>;
export const BoardArtworkView = z.object({ zoom: z.number().finite().min(.5).max(3), placing: z.boolean() });
export type BoardArtworkView = z.infer<typeof BoardArtworkView>;
export const SavedBoardArtwork = z.object({
  contract: z.literal("fabplane.board-artwork.v1"),
  owner: z.object({ projectId: z.string().min(1), board: z.literal("root") }),
  source: z.object({
    path: z.string().regex(/^artwork\/sources\/[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/),
    name: z.string().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(12 * 1024 * 1024),
  }),
  settings: BoardArtworkSettings,
  view: BoardArtworkView,
  savedAt: z.string().datetime(),
}).refine(record => record.source.path.split("/").pop()?.startsWith(`${record.source.sha256}.`), { message: "Artwork source path must identify its bytes." });
export type SavedBoardArtwork = z.infer<typeof SavedBoardArtwork>;
export const BOARD_ARTWORK_PATH = "artwork/board-art.json";
