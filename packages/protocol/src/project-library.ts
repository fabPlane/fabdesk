/** Git-native project files library: datasheets, docs and reference material next to the board. */
import { z } from "zod/v4";

export const PROJECT_LIBRARY_DIR = "files";
export const PROJECT_LIBRARY_FILE = "files/library.json";

export const PROJECT_LIBRARY_CONTRACT = {
  name: "fabplane.project-library",
  version: "1.0.0",
} as const;

export const LIBRARY_KINDS = [
  "datasheet",
  "app_note",
  "research",
  "reference_design",
  "image",
  "source",
  "other",
] as const;
export const LibraryKind = z.enum(LIBRARY_KINDS);
export type LibraryKind = z.infer<typeof LibraryKind>;

export const LIBRARY_ID_RE = /^fil_[A-Za-z0-9._:-]+$/;
export const LIBRARY_TITLE_MAX = 200;
export const LIBRARY_TAG_MAX = 40;
export const LIBRARY_FOLDER_MAX = 80;
export const LIBRARY_REF_MAX = 80;
export const LIBRARY_MPN_MAX = 80;
export const LIBRARY_MAX_ENTRIES = 500;
export const LIBRARY_MAX_FILE_BYTES = 25 * 1024 * 1024;

export const LibraryKindFromExt: Record<string, LibraryKind> = {
  pdf: "datasheet",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  svg: "image",
  md: "research",
  txt: "research",
  csv: "research",
  zip: "reference_design",
  step: "reference_design",
  stp: "reference_design",
  dxf: "reference_design",
  c: "source",
  h: "source",
  cpp: "source",
  ts: "source",
  py: "source",
};

export const LibraryEntry = z.object({
  id: z.string().regex(LIBRARY_ID_RE),
  path: z
    .string()
    .min(1)
    .max(240)
    .regex(/^files\/(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/),
  title: z.string().min(1).max(LIBRARY_TITLE_MAX),
  kind: LibraryKind,
  folder: z.string().min(1).max(LIBRARY_FOLDER_MAX),
  tags: z.array(z.string().min(1).max(LIBRARY_TAG_MAX)).max(24),
  linkedRefs: z.array(z.string().min(1).max(LIBRARY_REF_MAX)).max(64),
  linkedMpns: z.array(z.string().min(1).max(LIBRARY_MPN_MAX)).max(32),
  addedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

export const ProjectLibraryFile = z
  .object({
    contract: z.object({
      name: z.literal(PROJECT_LIBRARY_CONTRACT.name),
      version: z.literal(PROJECT_LIBRARY_CONTRACT.version),
    }),
    updatedAt: z.string().min(1),
    entries: z.array(LibraryEntry).max(LIBRARY_MAX_ENTRIES),
  })
  .strict();
export type ProjectLibraryFile = z.infer<typeof ProjectLibraryFile>;

export const LibraryEntryPatch = z
  .object({
    title: z.string().min(1).max(LIBRARY_TITLE_MAX).optional(),
    kind: LibraryKind.optional(),
    folder: z.string().min(1).max(LIBRARY_FOLDER_MAX).optional(),
    tags: z.array(z.string().min(1).max(LIBRARY_TAG_MAX)).max(24).optional(),
    linkedRefs: z.array(z.string().min(1).max(LIBRARY_REF_MAX)).max(64).optional(),
    linkedMpns: z.array(z.string().min(1).max(LIBRARY_MPN_MAX)).max(32).optional(),
  })
  .strict();
export type LibraryEntryPatch = z.infer<typeof LibraryEntryPatch>;

export const LibrarySearchHit = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  kind: LibraryKind,
  page: z.number().int().positive().nullable(),
  snippet: z.string().max(400),
  linkedRefs: z.array(z.string()),
});
export type LibrarySearchHit = z.infer<typeof LibrarySearchHit>;

/** Public allowlist for shared pages: no local roots, no raw bytes of large PDFs. */
export const SharedLibraryItem = z
  .object({
    id: z.string().regex(LIBRARY_ID_RE),
    title: z.string().min(1).max(LIBRARY_TITLE_MAX),
    path: z.string().min(1).max(240),
    kind: LibraryKind,
    folder: z.string().min(1).max(LIBRARY_FOLDER_MAX),
    tags: z.array(z.string().min(1).max(LIBRARY_TAG_MAX)).max(24),
    linkedRefs: z.array(z.string().min(1).max(LIBRARY_REF_MAX)).max(64),
    linkedMpns: z.array(z.string().min(1).max(LIBRARY_MPN_MAX)).max(32),
    mime: z.string().min(1).max(80),
    bytes: z.number().int().nonnegative(),
    pageCount: z.number().int().positive().nullable(),
    textExcerpt: z.string().max(2000),
    preview: z
      .object({
        contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        dataBase64: z
          .string()
          .max(600_000)
          .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SharedLibraryItem = z.infer<typeof SharedLibraryItem>;

export function emptyProjectLibraryFile(now = new Date().toISOString()): ProjectLibraryFile {
  return {
    contract: { ...PROJECT_LIBRARY_CONTRACT },
    updatedAt: now,
    entries: [],
  };
}

export function libraryKindForName(name: string): LibraryKind {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LibraryKindFromExt[ext] ?? "other";
}

export function defaultLibraryFolder(kind: LibraryKind): string {
  if (kind === "datasheet") return "datasheets";
  if (kind === "app_note") return "app-notes";
  if (kind === "research") return "research";
  if (kind === "reference_design") return "reference";
  if (kind === "image") return "images";
  if (kind === "source") return "sources";
  return "other";
}

export function libraryMimeForName(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      md: "text/markdown",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      zip: "application/zip",
      step: "model/step",
      stp: "model/step",
      c: "text/x-c",
      h: "text/x-c",
      cpp: "text/x-c++",
      ts: "text/x-typescript",
      py: "text/x-python",
    }[ext] ?? "application/octet-stream"
  );
}
