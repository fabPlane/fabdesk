import { realpath } from "node:fs/promises";
import {
  AssemblyPcbCheckReceipt,
  AssemblyBoardModelRevision,
  BoardModelRevision,
  sanitizeSharedGlb,
  PcbCheckSourceReceipt,
  ProjectShareSnapshot,
  type ProjectBoardSources,
  type SharedBoard,
} from "@fabdesk/protocol";
import { inspectOwnedProjectFile, inspectProjectBoardSources } from "./assembly";
import { sharedLibraryItems } from "./library";

const REPORT_LIMIT = 10 * 1024 * 1024;
const SVG_LIMIT = 12 * 1024 * 1024;
const TOTAL_LIMIT = 20 * 1024 * 1024;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const fingerprint = (scope: ProjectBoardSources) =>
  JSON.stringify({ mode: scope.mode, manifest: scope.manifestSha256, sources: scope.sources });

function findingCount(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const report = raw as Record<string, unknown>;
  if (!Array.isArray(report.violations)) return null;
  // Match the saved report categories, choosing the normalized form once.
  const groups = [
    report.violations,
    report.unconnected ?? report.unconnected_items,
    report.schematicParity ?? report.schematic_parity,
  ];
  return groups.reduce<number>(
    (sum, group) =>
      sum +
      (Array.isArray(group) ? group.filter((item) => item && typeof item === "object").length : 0),
    0,
  );
}

/** Construct the entire public payload locally. Raw reports and project manifests never leave disk. */
export async function prepareProjectShare(
  project: { id: string; name: string; dir: string },
  rasterize: (svg: string, options: { maxWidth: number }) => Promise<{ png: Uint8Array }>,
  options: { includeAssets?: boolean } = {},
) {
  const includeAssets = options.includeAssets !== false;
  const scope = await inspectProjectBoardSources(project),
    root = await realpath(project.dir);
  const boards: SharedBoard[] = [];
  const captured: Array<{ path: string; hash: string }> = [];
  let total = 0;
  for (const row of scope.sources) {
    const board: SharedBoard = {
      id: row.source.id,
      name: scope.mode === "single" ? project.name : row.source.name,
      sourceAvailable: row.status === "available",
      sourceState: row.status === "available" ? "pcb" : row.status === "missing" ? "missing" : "unavailable",
      modelState: "unavailable",
      checks: { state: "unavailable", findingCount: null },
      preview: null,
    };
    if (row.source.location === "project" && row.status === "missing") {
      const path = `${row.source.directory === "." ? "" : `${row.source.directory}/`}board.kicad_sch`;
      try {
        const schematic = await inspectOwnedProjectFile(root, path, 128 * 1024 * 1024);
        captured.push({ path, hash: schematic.sha256 });
        board.sourceState = "schematic-only";
      } catch (error) {
        if (isMissing(error)) captured.push({ path, hash: "missing" });
        else board.sourceState = "unavailable";
      }
    }
    if (row.source.location === "project" && row.status === "available" && row.pcbSha256) {
      const prefix = row.source.directory === "." ? "" : `${row.source.directory}/`;
      const read = async (path: string, limit: number) => {
        try {
          const file = await inspectOwnedProjectFile(root, path, limit, true);
          captured.push({ path, hash: file.sha256 });
          return file.text!;
        } catch (error) {
          if (isMissing(error)) {
            captured.push({ path, hash: "missing" });
            return null;
          }
          throw error;
        }
      };
      const reportText = await read(prefix + "reports/drc.json", REPORT_LIMIT);
      board.checks.state = "no-report";
      if (reportText !== null) {
        let raw: unknown;
        try {
          raw = JSON.parse(reportText);
        } catch {
          raw = null;
        }
        const receipt = PcbCheckSourceReceipt.safeParse(raw);
        const memberReceipt = AssemblyPcbCheckReceipt.safeParse(raw);
        const count = findingCount(raw);
        const owned =
          receipt.success &&
          (scope.mode === "single" ||
            (memberReceipt.success &&
              memberReceipt.data.boardSource.projectId === project.id &&
              memberReceipt.data.boardSource.sourceId === row.source.id &&
              memberReceipt.data.boardSource.manifestSha256 === scope.manifestSha256));
        board.checks = {
          state:
            !owned || count === null
              ? "unverified"
              : receipt.success && receipt.data.pcbRevision.sha256 === row.pcbSha256
                ? "source-unchanged"
                : "source-changed",
          findingCount: owned ? count : null,
        };
      }
      const modelPath = prefix + "renders/board.glb";
      try {
        const file = await inspectOwnedProjectFile(root, modelPath, 10 * 1024 * 1024, false, includeAssets);
        captured.push({ path: modelPath, hash: file.sha256 });
        const receiptText = await read(prefix + "renders/board.glb.revision.json", 64 * 1024);
        let raw: unknown = null;
        try { raw = receiptText ? JSON.parse(receiptText) : null; } catch { /* An unreadable receipt cannot establish freshness. */ }
        const receipt = BoardModelRevision.safeParse(raw), member = AssemblyBoardModelRevision.safeParse(raw);
        const owned = receipt.success && (scope.mode === "single" || (member.success && member.data.boardSource.projectId === project.id && member.data.boardSource.sourceId === row.source.id && member.data.boardSource.manifestSha256 === scope.manifestSha256));
        board.modelState = !owned || !receipt.success ? "unverified"
          : receipt.data.artifactSha256 !== file.sha256 ? "artifact-changed"
          : receipt.data.sourceSha256 !== row.pcbSha256 ? "source-changed" : "source-unchanged";
        if (includeAssets) {
          const model = sanitizeSharedGlb(file.data!);
          total += model.byteLength;
          if (total > TOTAL_LIMIT) throw new Error("Previews and 3D models exceed the 20 MiB sharing limit.");
          board.model = { contentType: "model/gltf-binary", dataBase64: Buffer.from(model).toString("base64") };
        }
      } catch (error) {
        if (!isMissing(error) && includeAssets)
          throw new Error(
            `The saved 3D model for ${board.name} cannot be shared. Export a self-contained model under 10 MiB and try again.`,
          );
        board.modelState = isMissing(error) ? "no-model" : "unavailable";
        if (isMissing(error)) captured.push({ path: modelPath, hash: "missing" });
      }
      const svg = includeAssets ? await read(prefix + "renders/pcb.svg", SVG_LIMIT) : null;
      if (svg !== null) {
        const rootTag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
        const box = /\bviewBox\s*=\s*["']([^"']+)["']/i
          .exec(rootTag)?.[1]
          ?.trim()
          .split(/[\s,]+/)
          .map(Number);
        if (
          !box ||
          box.length !== 4 ||
          !box.every(Number.isFinite) ||
          box[2]! <= 0 ||
          box[3]! <= 0 ||
          box[3]! / box[2]! > 1000
        )
          throw new Error(
            "The saved PCB preview has invalid dimensions. Regenerate it before sharing.",
          );
        const { png } = await rasterize(svg, {
          maxWidth: Math.max(1, Math.floor(Math.min(1200, (1200 * box[2]!) / box[3]!))),
        });
        if (png.byteLength > 6 * 1024 * 1024)
          throw new Error("A board preview is too large to share.");
        total += png.byteLength;
        if (total > TOTAL_LIMIT)
          throw new Error("Previews and 3D models exceed the 20 MiB sharing limit.");
        board.preview = {
          contentType: "image/png",
          dataBase64: Buffer.from(png).toString("base64"),
        };
      }
    }
    boards.push(board);
  }
  if (fingerprint(await inspectProjectBoardSources(project)) !== fingerprint(scope))
    throw new Error("Board sources changed while preparing the shared page. Try again.");
  // Verify outputs as well as native source hashes so mixed revisions are never published.
  for (const file of captured) {
    try {
      const current = await inspectOwnedProjectFile(
        root,
        file.path,
        Math.max(REPORT_LIMIT, SVG_LIMIT, 128 * 1024 * 1024),
      );
      if (current.sha256 !== file.hash) throw new Error("changed");
    } catch (error) {
      if (file.hash === "missing" && isMissing(error)) continue;
      throw new Error(
        "Saved previews or checks changed while preparing the shared page. Try again.",
      );
    }
  }
  const library = await sharedLibraryItems(project);
  return ProjectShareSnapshot.parse({
    schema: "fabplane.project-share.v1",
    name: project.name,
    capturedAt: new Date().toISOString(),
    boards,
    ...(library.length > 0 ? { library } : {}),
  });
}

/** Saved metadata only: never rasterizes previews, exports a model or contacts a sharing service. */
export function inspectProjectStatus(project: { id: string; name: string; dir: string }) {
  return prepareProjectShare(project, async () => { throw new Error("Status inspection cannot render a preview."); }, { includeAssets: false });
}
