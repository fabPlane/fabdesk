import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { link, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, makeContext, type AppBridge } from "../src";
import {
  preparePresentation,
  presentationBinding,
  summarizePresentationBinding,
} from "../src/presentation";
import { mockServices, tempProject } from "./mock-services";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const project = await tempProject("repository");
  roots.push(project.dir);
  await mkdir(join(project.dir, "hardware/io"), { recursive: true });
  await mkdir(join(project.dir, "hardware/carrier"), { recursive: true });
  await writeFile(
    join(project.dir, "hardware/io/IO-v7.kicad_pcb"),
    '(kicad_pcb (version 20250114) (generator "pcbnew"))',
  );
  await writeFile(
    join(project.dir, "hardware/carrier/Host-v2.kicad_pcb"),
    '(kicad_pcb (version 20250114) (generator "carrier"))',
  );
  await writeFile(
    join(project.dir, "AGENTS.md"),
    "# Existing policy\nRead hardware/current.md before work.\n",
  );
  const services = mockServices([project]);
  return { project, services, ctx: makeContext({ project, services, threadId: "chat-a" }) };
}
test("two native designs render from independent snapshots without root adoption or instruction changes", async () => {
  const { project, services, ctx } = await fixture();
  const calls: string[] = [];
  services.kicad.exportPcbSvg = async (_cli, { board, output }) => {
    expect(board.startsWith(project.dir)).toBe(false);
    calls.push(await readFile(board, "utf8"));
    await writeFile(output, `<svg>${calls.length}</svg>`);
    return { paths: [output] };
  };
  const before = await readFile(join(project.dir, "AGENTS.md"));
  const io = await preparePresentation(ctx, "hardware/io/IO-v7.kicad_pcb");
  const carrier = await preparePresentation(ctx, "hardware/carrier/Host-v2.kicad_pcb");
  expect(io.path).not.toBe(carrier.path);
  expect(io.sourceBinding).toMatchObject({
    status: "current",
    source: "hardware/io/IO-v7.kicad_pcb",
  });
  expect(calls[0]).toContain('"pcbnew"');
  expect(calls[1]).toContain('"carrier"');
  expect(await readFile(join(project.dir, "AGENTS.md"))).toEqual(before);
  expect(await readdir(project.dir)).not.toContain("board.kicad_pcb");
  await writeFile(join(project.dir, "hardware/io/IO-v7.kicad_pcb"), "changed source");
  expect(await presentationBinding(project.dir, io.path, io.artifactSha256)).toMatchObject({
    status: "stale",
  });
  expect(
    await presentationBinding(project.dir, carrier.path, carrier.artifactSha256),
  ).toMatchObject({ status: "current" });
});
test("a change during export cannot become a current presentation", async () => {
  const { project, services, ctx } = await fixture();
  services.kicad.exportPcbSvg = async (_cli, { output }) => {
    await writeFile(output, "<svg/>");
    await writeFile(join(project.dir, "hardware/io/IO-v7.kicad_pcb"), "changed");
    return { paths: [output] };
  };
  await expect(preparePresentation(ctx, "hardware/io/IO-v7.kicad_pcb")).rejects.toThrow(
    "changed while rendering",
  );
});
test("presentation is scoped to the requesting chat and rechecks actual artifact bytes", async () => {
  const { project, services } = await fixture();
  const registry = createRegistry();
  await writeFile(join(project.dir, "README.md"), "# Project");
  const calls: unknown[] = [];
  const bridge: AppBridge = {
    status: async () => ({ running: true, url: "local", pid: 1 }),
    call: async <T>(_method: "GET" | "POST", _path: string, body?: unknown) => {
      const request = body as { action: string; args: unknown[] };
      calls.push(request);
      if (request.action === "presentationContext")
        return { result: { projectId: project.id, threadId: "chat-b", navigationVersion: 0 } } as T;
      throw new Error("must not navigate another chat");
    },
  };
  services.appBridge = bridge;
  const result = await registry.invoke("app_present", { path: "README.md" }, () =>
    makeContext({ project, services, threadId: "chat-a" }),
  );
  expect(result.json).toMatchObject({ status: "chat-inactive" });
  expect(calls).toHaveLength(1);
  await expect(
    preparePresentation(makeContext({ project, services }), "../outside.md"),
  ).rejects.toThrow();
});
test("schematic snapshots preserve nested sheet paths and native basenames", async () => {
  const { project, services, ctx } = await fixture();
  const path = "hardware/io/IO-v7.kicad_sch";
  const child = '(kicad_sch (version 20250114) (uuid "child"))';
  const root =
    '(kicad_sch (version 20250114) (uuid "root") (sheet (uuid "s") (property "Sheetname" "Power") (property "Sheetfile" "sheets/power.kicad_sch")))';
  await mkdir(join(project.dir, "hardware/io/sheets"));
  await writeFile(join(project.dir, path), root);
  await writeFile(join(project.dir, "hardware/io/sheets/power.kicad_sch"), child);
  services.kicad.exportSchematicSvg = async (_cli, { schematic, outDir }) => {
    expect(await readFile(schematic, "utf8")).toBe(root);
    expect(await readFile(join(schematic, "../sheets/power.kicad_sch"), "utf8")).toBe(child);
    const output = join(outDir, "IO-v7.svg");
    await writeFile(output, "<svg/>");
    return { paths: [output] };
  };
  const result = await preparePresentation(ctx, path);
  expect(result.sourceBinding.status).toBe("current");
  await writeFile(join(project.dir, "hardware/io/sheets/power.kicad_sch"), child + "\n");
  expect((await presentationBinding(project.dir, result.path, result.artifactSha256)).status).toBe(
    "stale",
  );
});

test("refreshing a preview replaces cache hard links without changing original instruction bytes", async () => {
  const { project, ctx } = await fixture();
  const result = await preparePresentation(ctx, "hardware/io/IO-v7.kicad_pcb");
  const instructions = await readFile(join(project.dir, "AGENTS.md"));
  await unlink(join(project.dir, result.path));
  await link(join(project.dir, "AGENTS.md"), join(project.dir, result.path));
  await preparePresentation(ctx, "hardware/io/IO-v7.kicad_pcb");
  expect(await readFile(join(project.dir, "AGENTS.md"))).toEqual(instructions);
});

test("large dependency receipts become bounded panel observations without losing source identity", () => {
  const inputs: Record<string, string | null> = { "io/board.kicad_pcb": "a".repeat(64) };
  for (let i = 0; i < 127; i++) inputs[`${"sheet/".repeat(150)}${i}.kicad_sch`] = "b".repeat(64);
  const summary = summarizePresentationBinding({
    source: "io/board.kicad_pcb",
    artifactSha256: "c".repeat(64),
    inputs,
    status: "current",
    checkedAt: new Date().toISOString(),
    dependencies: "external assets unverified",
  });
  expect(JSON.stringify(summary).length).toBeLessThan(2048);
  expect(summary).toMatchObject({
    source: "io/board.kicad_pcb",
    sourceSha256: "a".repeat(64),
    inputCount: 128,
  });
  expect(summary).not.toHaveProperty("inputs");
});

test("a source changed after the expected-hash check cannot silently replace the requested revision", async () => {
  const { project, services } = await fixture();
  const path = "hardware/io/IO-v7.kicad_pcb",
    registry = createRegistry();
  const expectedSha256 = createHash("sha256")
    .update(await readFile(join(project.dir, path)))
    .digest("hex");
  const originalCli = services.kicad.resolveCli;
  services.kicad.resolveCli = async () => {
    await writeFile(join(project.dir, path), '(kicad_pcb (generator "new-revision"))');
    return originalCli();
  };
  let calls = 0;
  services.appBridge = {
    status: async () => ({ running: true, url: "local", pid: 1 }),
    call: async <T>() => {
      calls++;
      return { result: { projectId: project.id, threadId: "chat-a", navigationVersion: 0 } } as T;
    },
  };
  await expect(
    registry.invoke("app_present", { path, expectedSha256 }, () =>
      makeContext({ project, services, threadId: "chat-a" }),
    ),
  ).rejects.toThrow("changed");
  expect(calls).toBe(1);
});

test("a changed artifact cannot retain a displayed receipt for the previous bytes", async () => {
  const { project, services } = await fixture();
  const registry = createRegistry();
  await writeFile(join(project.dir, "README.md"), "original text");
  services.appBridge = {
    status: async () => ({ running: true, url: "local", pid: 1 }),
    call: async <T>(_method: "GET" | "POST", _path: string, body?: unknown) => {
      const request = body as { action: string };
      if (request.action === "presentationContext")
        return { result: { projectId: project.id, threadId: "chat-a", navigationVersion: 0 } } as T;
      await writeFile(join(project.dir, "README.md"), "externally changed text");
      return { result: { status: "displayed" } } as T;
    },
  };
  const result = await registry.invoke("app_present", { path: "README.md" }, () =>
    makeContext({ project, services, threadId: "chat-a" }),
  );
  expect(result.json).toMatchObject({ status: "changed-during-presentation" });
});

test("PCB, schematic and 3D use one native revision and all become stale when a child sheet changes", async () => {
  const { project, services, ctx } = await fixture();
  const stem = "hardware/io/IO-v7",
    child = `${stem}-child.kicad_sch`;
  await writeFile(
    join(project.dir, `${stem}.kicad_sch`),
    '(kicad_sch (version 20250114) (uuid "r") (sheet (uuid "s") (property "Sheetfile" "IO-v7-child.kicad_sch")))',
  );
  await writeFile(join(project.dir, child), '(kicad_sch (version 20250114) (uuid "c"))');
  services.kicad.exportSchematicSvg = async (_cli, { outDir }) => {
    const output = join(outDir, "IO-v7.svg");
    await writeFile(output, "<svg/>");
    return { paths: [output] };
  };
  services.kicad.exportGlb = async (_cli, { output, modelProjectDir }) => {
    expect(modelProjectDir).toBe(join(project.dir, "hardware/io"));
    await writeFile(output, "model-fixture");
    return { fused: false, warnings: ["component model unavailable"] };
  };
  const rendered = [];
  for (const kind of ["pcb", "schematic", "3d"] as const)
    rendered.push(await preparePresentation(ctx, `${stem}.kicad_pcb`, kind));
  const bindings = rendered.map((result) => summarizePresentationBinding(result.sourceBinding));
  expect(
    new Set(
      bindings.map((binding) => ("sourceRevision" in binding ? binding.sourceRevision : null)),
    ).size,
  ).toBe(1);
  expect(bindings[2]).toMatchObject({ warnings: ["component model unavailable"] });
  await writeFile(join(project.dir, child), '(kicad_sch (version 20250114) (uuid "c"))\n');
  for (const result of rendered)
    expect(
      (await presentationBinding(project.dir, result.path, result.artifactSha256)).status,
    ).toBe("stale");
});

test("prepared native views reuse verified bytes without another export and replace a corrupt cache", async () => {
  const { project, services, ctx } = await fixture();
  let calls = 0;
  services.kicad.exportPcbSvg = async (_cli, { output }) => {
    calls++;
    await writeFile(output, "<svg>prepared</svg>");
    return { paths: [output] };
  };
  const path = "hardware/io/IO-v7.kicad_pcb";
  const first = await preparePresentation(ctx, path, "pcb");
  const second = await preparePresentation(ctx, path, "pcb");
  expect(second.artifactSha256).toBe(first.artifactSha256);
  expect(calls).toBe(1);
  await writeFile(join(project.dir, first.path), "corrupt preview");
  expect((await preparePresentation(ctx, path, "pcb")).artifactSha256).toBe(first.artifactSha256);
  expect(calls).toBe(2);
});

test("an explicitly requested tab reveal stays in its requesting conversation", async () => {
  const { project, services } = await fixture();
  const registry = createRegistry();
  const actions: string[] = [];
  let activeThread = "other-chat";
  services.appBridge = {
    status: async () => ({ running: true, url: "local", pid: 1 }),
    call: async <T>(_method: "GET" | "POST", _path: string, body?: unknown) => {
      const request = body as { action: string };
      actions.push(request.action);
      return {
        result:
          request.action === "presentationContext"
            ? { projectId: project.id, threadId: activeThread }
            : { boardTab: "pcb" },
      } as T;
    },
  };
  const context = () => makeContext({ project, services, threadId: "requesting-chat" });
  expect((await registry.invoke("app_open_tab", { tab: "pcb" }, context)).json).toMatchObject({
    status: "chat-inactive",
  });
  expect(actions).toEqual(["presentationContext"]);
  activeThread = "requesting-chat";
  await registry.invoke("app_open_tab", { tab: "pcb" }, context);
  expect(actions).toEqual(["presentationContext", "presentationContext", "openTab"]);
});

test("existing board-view export profiles are retained for native PCB, schematic and GLB", async () => {
  const { project, services, ctx } = await fixture();
  const stem = "hardware/io/IO-v7";
  await writeFile(
    join(project.dir, `${stem}.kicad_sch`),
    '(kicad_sch (version 20250114) (uuid "root"))',
  );
  let pcb = false,
    schematic = false,
    model = false;
  services.kicad.exportPcbSvg = async (_cli, options) => {
    // Undefined layers invokes main's copper/silkscreen/edge profile, not a new simplified renderer.
    expect(options.layers).toBeUndefined();
    expect(options.signal).toBe(ctx.signal);
    pcb = true;
    await writeFile(options.output, "<svg/>");
    return { paths: [options.output] };
  };
  services.kicad.exportSchematicSvg = async (_cli, options) => {
    expect(options.schematic.endsWith("/hardware/io/IO-v7.kicad_sch")).toBe(true);
    const path = join(options.outDir, "IO-v7.svg");
    await writeFile(path, "<svg/>");
    schematic = true;
    return { paths: [path] };
  };
  services.kicad.exportGlb = async (_cli, options) => {
    // Main's board GLB profile; the enclosure-only mechanical profile has a different frame.
    expect(options.mechanical).toBeUndefined();
    expect(options.includeDnp).toBeUndefined();
    expect(options.modelProjectDir).toBe(join(project.dir, "hardware/io"));
    model = true;
    await writeFile(options.output, "glb-fixture");
    return { fused: true, warnings: [] };
  };
  for (const kind of ["pcb", "schematic", "3d"] as const)
    await preparePresentation(ctx, `${stem}.kicad_pcb`, kind);
  expect([pcb, schematic, model]).toEqual([true, true, true]);
});
