/** Isolated ProjectHandle for library tests. Does not load the full tool registry. */
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectManifest } from "@fabdesk/protocol";
import type { ProjectHandle, ToolContext } from "../registry";

export async function libraryTestProject(name = "library"): Promise<ProjectHandle> {
  const dir = join(await mkdtemp(join(tmpdir(), "fabdesk-library-")), name);
  await mkdir(dir, { recursive: true });
  let manifest: ProjectManifest = {
    schema: 1,
    id: `p_${name}`,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    board: { layers: 2 },
    agent: {},
    allowedDrcWarnings: [],
  };
  return {
    id: manifest.id,
    name,
    dir,
    manifest: () => manifest,
    updateManifest: async (patch) => {
      manifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
      return manifest;
    },
  };
}

export function libraryToolContext(project: ProjectHandle): ToolContext {
  return {
    project,
    requireProject: () => project,
    services: {} as ToolContext["services"],
    signal: new AbortController().signal,
    progress: () => {},
    principal: null,
  };
}
