import { FpPcbSessions, type ProjectSession } from "../src/fp-pcb-session";
import { bindNativeSource } from "../src/native-source-binding";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withNativeLayout, nativeProjectPath, jailPath, createRegistry } from "@fabdesk/tools";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { WorkingDesigns } from "../src/working-design";
import { createContextFactory } from "../src/context";
import { TokenSet } from "../src/auth";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-working-")),
    project = await tempProject("native");
  roots.push(home, project.dir);
  await mkdir(join(project.dir, "hardware"));
  for (const name of ["io-v3", "carrier-v7"])
    await writeFile(
      join(project.dir, `hardware/${name}.kicad_pcb`),
      `(kicad_pcb (version 20250114) (generator "${name}"))`,
    );
  await writeFile(join(project.dir, "AGENTS.md"), "Keep native revisions.\n");
  const designs = new WorkingDesigns(home);
  return { home, project, designs };
}
test("working sources persist outside the repository, scoped to project and conversation", async () => {
  const { home, project, designs } = await fixture();
  const before = await readdir(project.dir),
    manifest = await readFile(join(project.dir, "fabdesk.json"));
  await designs.select(project, "hardware/io-v3.kicad_pcb", "io", 100);
  await designs.select(project, "hardware/carrier-v7.kicad_pcb", "carrier", 200);
  expect((await new WorkingDesigns(home).describe(project, "io")).sourcePath).toBe(
    "hardware/io-v3.kicad_pcb",
  );
  expect((await designs.describe(project, "carrier")).sourcePath).toBe(
    "hardware/carrier-v7.kicad_pcb",
  );
  expect(await designs.describe(project, "other")).toEqual({ sourcePath: null });
  expect(await designs.describe({ ...project, id: "other" }, "io")).toEqual({ sourcePath: null });
  expect(await readdir(project.dir)).toEqual(before);
  expect(await readFile(join(project.dir, "fabdesk.json"))).toEqual(manifest);
  expect(await readFile(join(project.dir, "AGENTS.md"), "utf8")).toBe("Keep native revisions.\n");
  await expect(designs.select(project, "hardware/carrier-v7.kicad_pcb", "io", 99)).rejects.toThrow(
    "newer",
  );
  await expect(designs.select(project, "../outside.kicad_pcb", "io")).rejects.toThrow();
});
test("semantic source declaration binds normal operations to the selected originals and rejects a retargeted scope", async () => {
  const { project, designs } = await fixture();
  const services = mockServices([project]),
    tokens = new TokenSet("test-daemon-token");
  const token = tokens.mintRunToken({
    runId: "run",
    projectId: project.id,
    threadId: "chat",
    contextCapturedAt: 100,
  });
  const factory = createContextFactory({
    services,
    tokens,
    projects: {
      handle: async () => project,
      resolve: async () => project,
      isPromoting: () => false,
    } as never,
    workingDesigns: designs,
  });
  const registry = createRegistry();
  const context = (projectRef: string | undefined, def: Parameters<typeof factory>[0]["def"]) =>
    factory({ projectRef, def, token, signal: new AbortController().signal, progress: () => {} });
  const result = await registry.invoke(
    "project_set_board",
    { sourcePath: "hardware/io-v3.kicad_pcb" },
    context,
  );
  expect(result.json).toMatchObject({ workingDesign: { sourcePath: "hardware/io-v3.kicad_pcb" } });
  const def = registry.get("render_pcb_svg")!;
  const captured = await context(undefined, def);
  expect(captured.requireProject().dir).toBe(join(project.dir, "hardware"));
  expect(captured.nativeSource?.sourcePath).toBe("hardware/io-v3.kicad_pcb");
  expect(await captured.runInScope!(() => jailPath(captured.requireProject().dir, "board.kicad_pcb"))).toBe(join(project.dir, "hardware/io-v3.kicad_pcb"));
  await designs.select(project, "hardware/carrier-v7.kicad_pcb", "chat", 101);
  await expect(captured.runInScope!(async () => {})).rejects.toThrow("ownership changed");
});

test("two native basenames in one folder have independent sessions, caches and captured saves", async () => {
  const { project, designs } = await fixture();
  await designs.select(project, "hardware/io-v3.kicad_pcb", "a", 1);
  await designs.select(project, "hardware/carrier-v7.kicad_pcb", "b", 1);
  const a = await bindNativeSource(project, { projectId: project.id, threadId: "a", sourcePath: "hardware/io-v3.kicad_pcb" }, designs);
  const b = await bindNativeSource(project, { projectId: project.id, threadId: "b", sourcePath: "hardware/carrier-v7.kicad_pcb" }, designs);
  const sessions = new FpPcbSessions(() => ({ deleteSession: async () => { closed++; } }) as never);
  let closed = 0;
  (sessions as unknown as { connect: (dir: string) => Promise<ProjectSession> }).connect = async dir => {
    const path = nativeProjectPath(dir, "board.kicad_pcb");
    const doc = () => ({ modified: async () => false, close: async () => {}, save: async () => { await writeFile(path, "saved owned bytes"); } });
    return { id: path, path, ws: { close: async () => {} }, kicad: { currentBoard: async () => doc(), currentSchematic: async () => null, openBoard: async () => doc() } } as unknown as ProjectSession;
  };
  const first = await withNativeLayout(a, () => sessions.session(a.directory));
  const second = await withNativeLayout(b, () => sessions.session(b.directory));
  expect(first.path).toBe(join(project.dir, "hardware/io-v3.kicad_pcb"));
  expect(second.path).toBe(join(project.dir, "hardware/carrier-v7.kicad_pcb"));
  expect(first).not.toBe(second);
  await withNativeLayout(a, async () => {
    const path = await jailPath(a.directory, "renders/pcb.svg");
    expect(await jailPath(a.directory, path)).toBe(path);
    expect(path.startsWith(a.cacheDirectory)).toBe(true);
    expect(path.startsWith(b.cacheDirectory)).toBe(false);
  });
  const document = await withNativeLayout(a, () => sessions.board(a.directory));
  await document.save(); // Captured ownership survives leaving the request's async-local scope.
  expect(await readFile(first.path!, "utf8")).toBe("saved owned bytes");
  await designs.select(project, "hardware/carrier-v7.kicad_pcb", "a", 2);
  await expect(document.save()).rejects.toThrow("ownership changed");
  expect(await readFile(second.path!, "utf8")).toContain("carrier-v7");
  await sessions.dispose();
  expect(closed).toBe(2);
});
