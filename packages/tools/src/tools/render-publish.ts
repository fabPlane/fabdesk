import { stockModelCacheRoot, withModelCache } from "@fabdesk/kicad";
import { beginPublicationVisibility } from "../publication-visibility";
import { snapshotProjectDependencies, assertProjectDependencies } from "../project-dependencies";
/** Prepare a saved-file handoff privately, then publish only if every captured input is unchanged. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod/v4";
import { jailPath, writeAtomic, writeJson } from "../fs";
import { defineTool, ToolError, type ToolContext } from "../registry";
import { inspectSavedHierarchy, ok, requireKicad } from "./common";
import { verify_drc } from "./core";
import { verify_erc } from "./verify";
import { render_glb, render_pcb_svg, render_schematic_svg } from "./render";

const activePublications = new Set<string>();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const render_publish = defineTool({
  name: "render_publish",
  boardScoped: true,
  toolset: "core",
  title: "Publish saved design handoff",
  description:
    "Publish canonical PCB, complete schematic and interactive 3D previews plus DRC/ERC reports from the final saved files. Stages outputs privately and rejects intervening edits. Returns check failures and declared model coverage; does not navigate the desktop or approve manufacturing. Single-board projects only.",
  inputSchema: { maxWidth: z.number().int().min(320).max(4096).default(1600) },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ maxWidth }, ctx) => withModelCache(stockModelCacheRoot(), async () => {
    if (ctx.board)
      throw new ToolError(
        "Combined handoff publishing is not yet supported for assembly members; use the source-qualified render and check tools.",
        "precondition",
      );
    const project = ctx.requireProject();
    if (activePublications.has(project.dir))
      throw new ToolError(
        "A saved-file handoff is already being prepared for this project",
        "precondition",
      );
    activePublications.add(project.dir);
    try {
      const cli = await requireKicad(ctx);
      const hierarchy = await inspectSavedHierarchy(ctx, project, cli);
      if (!hierarchy.complete)
        throw new ToolError(
          "Publishing requires a complete saved schematic hierarchy",
          "precondition",
        );
      const previewHierarchy = await ctx.services.kicad.inspectSchematicHierarchy(cli, {
        projectDir: project.dir,
        rootSchematic: await jailPath(project.dir, "board.kicad_sch"),
        ...(hierarchy.projectFile
          ? { projectFile: await jailPath(project.dir, hierarchy.projectFile) }
          : {}),
        ownedFilesOnly: true,
        signal: ctx.signal,
      });
      if (!previewHierarchy.complete)
        throw new ToolError(
          "Publishing requires a complete project-owned preview hierarchy",
          "precondition",
        );
      const imported = project.manifest().importedBoard;
      await ctx.services.kicad.prepareModels(cli, {
        board: await jailPath(project.dir, "board.kicad_pcb"),
        modelProjectDir: imported ? dirname(await jailPath(project.dir, imported.path)) : project.dir,
        signal: ctx.signal,
      });
      const dependencies = await snapshotProjectDependencies(project.dir);
      const inputs = new Map<string, Buffer>();
      for (const path of new Set([
        "board.kicad_pcb",
        ...dependencies.files.filter(file => file.sha256 !== null).map(file => file.path),
        ...hierarchy.referencedFiles,
        ...(hierarchy.projectFile ? [hierarchy.projectFile] : []),
      ]))
        inputs.set(path, await readFile(await jailPath(project.dir, path)));
      const pcbRevision = sha(inputs.get("board.kicad_pcb")!);
      const stable = async () => {
        ctx.signal.throwIfAborted();
        await assertProjectDependencies(project.dir, dependencies);
        for (const [path, bytes] of inputs) {
          const current = await readFile(await jailPath(project.dir, path)).catch(() => null);
          if (!current || sha(current) !== sha(bytes))
            throw new ToolError(
              "Saved design changed during handoff preparation; nothing was published. Run render_publish after the last edit.",
              "precondition",
            );
        }
        const current = await inspectSavedHierarchy(ctx, project, cli);
        if (
          !current.complete ||
          current.aggregateRevision !== hierarchy.aggregateRevision ||
          current.projectFile !== hierarchy.projectFile
        )
          throw new ToolError(
            "Saved hierarchy changed during handoff preparation; nothing was published.",
            "precondition",
          );
      };
      // Staging stays inside the project jail and never opens another live design session.
      const parent = await jailPath(project.dir, ".fabdesk/handoff");
      await writeAtomic(join(parent, ".keep"), "");
      const stage = await mkdtemp(join(parent, "prepare-"));
      try {
        for (const [path, bytes] of inputs) await writeAtomic(await jailPath(stage, path), bytes);
        const stagedProject = {
          ...project,
          dir: stage,
          manifest: () => {
            const { importedBoard, ...rest } = project.manifest();
            return rest;
          },
        };
        const originalPath = (path: string) => join(project.dir, relative(stage, path));
        const kicad = ctx.services.kicad;
        const staged: ToolContext = {
          ...ctx,
          project: stagedProject,
          requireProject: () => stagedProject,
          services: {
            ...ctx.services,
            design: {
              ...ctx.services.design,
              query: (_dir, ...args) => ctx.services.design.query(project.dir, ...args),
            },
            kicad: {
              ...kicad,
              inspectSchematicHierarchy: (binary, options) =>
                kicad.inspectSchematicHierarchy(binary, {
                  ...options,
                  projectDir: project.dir,
                  rootSchematic: originalPath(options.rootSchematic),
                  ...(options.projectFile
                    ? { projectFile: originalPath(options.projectFile) }
                    : {}),
                }),
              exportOwnedSchematicSvg: (binary, options) =>
                kicad.exportOwnedSchematicSvg(binary, { ...options, projectDir: project.dir }),
              exportGlb: async (binary, options) =>
                kicad.exportGlb(binary, {
                  ...options,
                  board: originalPath(options.board),
                  modelProjectDir: project.manifest().importedBoard
                    ? dirname(await jailPath(project.dir, project.manifest().importedBoard!.path))
                    : project.dir,
                }),
              measureMechanical: (binary, options) => kicad.measureMechanical(binary, { ...options, board: originalPath(options.board), projectDir: project.manifest().importedBoard ? dirname(join(project.dir, project.manifest().importedBoard!.path)) : project.dir }),
              runDrc: (binary, options) =>
                kicad.runDrc(binary, { ...options, board: originalPath(options.board) }),
              runErc: (binary, options) =>
                kicad.runErc(binary, { ...options, schematic: originalPath(options.schematic) }),
            },
          },
        };
        await stable();
        await render_pcb_svg.handler({ expectedSourceSha256: pcbRevision }, staged);
        await render_schematic_svg.handler(
          {
            maxWidth,
            circuit: false,
            expectedHierarchyRevision: previewHierarchy.aggregateRevision,
          },
          staged,
        );
        const model = await render_glb.handler({ expectedSourceSha256: pcbRevision }, staged);
        await verify_drc.handler(
          {
            severity: "all",
            schematicParity: true,
            limit: 30,
            responseMode: "summary",
            expectedSourceSha256: pcbRevision,
          },
          staged,
        );
        await verify_erc.handler({ severity: "all", limit: 30 }, staged);
        const drc = JSON.parse(await readFile(join(stage, "reports/drc.json"), "utf8"));
        const erc = JSON.parse(await readFile(join(stage, "reports/erc.json"), "utf8"));
        await stable();
        // Report checks ran on the original native documents; retain their original dependency context.
        drc.projectDependencies = dependencies; erc.projectDependencies = dependencies;
        await writeJson(join(stage, "reports/drc.json"), drc);
        await writeJson(join(stage, "reports/erc.json"), erc);
        for (const path of ["renders/pcb.svg.revision.json", "renders/board.glb.revision.json", "renders/schematic.revision.json"]) {
          const receipt = JSON.parse(await readFile(join(stage, path), "utf8"));
          receipt.dependencySnapshot = dependencies;
          await writeJson(join(stage, path), receipt);
        }
        const outputs: Array<{ path: string; bytes: Buffer }> = [];
        const collect = async (dir: string) => {
          for (const entry of await readdir(join(stage, dir), { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) await collect(path);
            else if (entry.isFile())
              outputs.push({ path, bytes: await readFile(await jailPath(stage, path)) });
          }
        };
        await collect("renders");
        await collect("reports");
        // Validate every output jail before replacing any canonical artifact.
        for (const output of outputs) await jailPath(project.dir, output.path);
        await stable();
        const previous = new Map<string, Buffer | null>();
        for (const output of outputs)
          previous.set(
            output.path,
            await readFile(await jailPath(project.dir, output.path)).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            ),
          );
        const visibility = await beginPublicationVisibility(project.dir, outputs);
        const written: typeof outputs = [];
        try {
          for (const output of outputs) {
            await writeAtomic(await jailPath(project.dir, output.path), output.bytes);
            written.push(output);
          }
          await stable();
          await visibility.commit();
        } catch (error) {
          for (const output of written.reverse()) {
            const path = await jailPath(project.dir, output.path);
            const current = await readFile(path).catch(() => null);
            // Do not roll back an artifact replaced independently by another writer.
            if (current && sha(current) === sha(output.bytes)) {
              const old = previous.get(output.path);
              if (old) await writeAtomic(path, old);
              else await rm(path, { force: true });
            }
          }
          await visibility.rollback();
          throw error;
        }
        const modelCoverage = (model.json as { modelCoverage?: unknown }).modelCoverage;
        const checksPass =
          drc.counts.errors === 0 &&
          drc.counts.unconnected === 0 &&
          erc.counts.errors === 0 &&
          erc.measurement?.evidenceLevel === "measured" &&
          erc.measurement?.revisionStable === true;
        return {
          ...ok(
            `Published current PCB, schematic, interactive 3D and canonical reports. Saved-board DRC: ${drc.counts.errors} errors, ${drc.counts.unconnected} open; ERC: ${erc.counts.errors} errors. ${checksPass ? "Electrical checks passed." : "Checks need attention; inspect the canonical reports."}`,
            {
              pcbRevision,
              schematicRevision: previewHierarchy.aggregateRevision,
              checkedSchematicRevision: hierarchy.aggregateRevision,
              modelCoverage,
              dependencies,
              checksPass,
              drc: drc.counts,
              erc: erc.counts,
              outputs: outputs.map((output) => output.path.split(sep).join("/")),
            },
          ),
          isError: !checksPass,
        };
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } finally {
      activePublications.delete(project.dir);
    }
  }),
});
