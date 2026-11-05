import type { BoardSourceSelection } from "@fabdesk/protocol";
import type { ToolRunState } from "./tools";

export function gerberPackageFilename(name: string) {
  return `${name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+|[-.]+$/g, "").slice(0, 160) || "board"}-gerbers.zip`;
}

function resultFiles(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("json" in result) || !result.json || typeof result.json !== "object" || !("files" in result.json) || !Array.isArray(result.json.files)) return [];
  return result.json.files.filter((file): file is string => typeof file === "string");
}

/** Reuse the guarded native exporters and package only files from this run. */
export async function exportGerberPackage(options: {
  projectId: string; sourceSha256: string; filename: string; board?: BoardSourceSelection;
  run: (tool: string, args: Record<string, unknown>) => Promise<ToolRunState>;
  isCurrent: () => boolean; onPhase: (label: string) => void;
}) {
  const args = { projectId: options.projectId, expectedSourceSha256: options.sourceSha256, ...(options.board ? { board: options.board } : {}) };
  const invoke = async (tool: string, label: string, extra = {}) => {
    if (!options.isCurrent()) throw new Error("Project changed. Reopen this export to review its results.");
    options.onPhase(label);
    const response = await options.run(tool, { ...args, ...extra });
    if (response.status !== "done" || response.result && typeof response.result === "object" && "isError" in response.result && response.result.isError) {
      throw new Error(response.error || `${label.replace(/…$/, "")} did not finish. Existing files are retained; review before downloading.`);
    }
    return resultFiles(response.result);
  };
  const gerbers = await invoke("export_gerbers", "Exporting Gerber layers…");
  if (!gerbers.some(path => /\.(gbr|g[a-z0-9]+)$/i.test(path) && !path.endsWith(".gbrjob"))) throw new Error("The exporter did not report any Gerber layers. No package was created.");
  const drills = await invoke("export_drill", "Exporting drill files…");
  if (!drills.some(path => /\.(drl|xln)$/i.test(path))) throw new Error("The exporter did not report a drill file. The Gerber layers were kept; no package was created.");
  const names = [...new Set([...gerbers, ...drills].map(path => {
    const match = path.replaceAll("\\", "/").match(/(?:^|\/)exports\/gerbers\/([^/]+)$/);
    if (!match || !match[1] || match[1] === "." || match[1] === "..") throw new Error("The exporter returned a file outside this board’s manufacturing folder. No package was created.");
    return match[1];
  }))];
  const packaged = await invoke("export_zip", "Packaging manufacturing files…", { filename: options.filename, gerberFiles: names });
  if (packaged.length !== names.length || names.some(name => !packaged.includes(`gerbers/${name}`))) throw new Error("The ZIP contents do not match this export’s Gerber and drill files. Review the saved files before downloading.");
  return { filename: options.filename, files: packaged };
}
