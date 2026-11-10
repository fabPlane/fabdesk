import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CloudService, type CloudApi, prepareEditableBoard } from "@fabdesk/tools";
import { Store } from "../db";
import { ProjectStore } from "../projects";
import { cloudRoutes } from "./cloud-routes";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of clean.splice(0)) await action();
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "contributor-native-"))),
    store = Store.open(join(root, "db.sqlite"));
  const projects = new ProjectStore(store.projects, join(root, "projects"), () => {}, {
    watch: false,
  });
  await projects.init();
  clean.push(async () => {
    projects.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const local = await projects.create("Controller"),
    remoteId = randomUUID();
  const pcb = "(kicad_pcb (version 20241229) (generator pcbnew))";
  await writeFile(join(local.path, "board.kicad_pcb"), pcb);
  let head: string | null = null;
  let role = "owner";
  let fail = false;
  const publications: unknown[] = [];
  const api = {
    listSharedProjects: async () => ({
      projects: [
        {
          id: remoteId,
          name: "Shared",
          role,
          publishedAt: new Date().toISOString(),
          localProjectId: local.id,
        },
      ],
    }),
    listContributionBoards: async () => ({
      role,
      boards: [
        {
          id: "main",
          name: "Main controller",
          revision: head,
          publishedAt: head ? new Date().toISOString() : null,
          publishedBy: head ? "Owner" : null,
        },
      ],
    }),
    downloadBoardSource: async () => ({
      projectId: remoteId,
      boardId: "main",
      revision: head,
      name: "Main controller",
      files: { pcb },
    }),
    publishBoardRevision: async (_p: string, _b: string, input: any) => {
      publications.push(input);
      if (fail) throw Object.assign(new Error("Newer revision"), { status: 409, code: "conflict" });
      head = randomUUID();
      return { revision: head };
    },
  } as unknown as CloudApi;
  const cloud = new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => "fixture-device",
    orgSetting: () => null,
    api: () => api,
  });
  let desktop = true;
  const app = cloudRoutes({
    cloud: () => cloud,
    projects,
    canManageSharing: () => desktop,
    readBom: async () => {
      throw Error("unused");
    },
    rasterizeSharePreview: async () => ({ png: new Uint8Array() }),
  });
  return {
    root,
    local,
    projects,
    api,
    remoteId,
    pcb,
    app,
    publications,
    setHead: (v: string) => {
      head = v;
    },
    getHead: () => head,
    setRole: (v: string) => {
      role = v;
    },
    setFailure: () => {
      fail = true;
    },
    remote: () => {
      desktop = false;
    },
  };
}
test("explicit source publication records a base; stale copies cannot silently refresh their base", async () => {
  const f = await setup(),
    path = `/projects/${f.local.id}/contributions/main`;
  const first = await f.app.request(path, { method: "PUT" });
  expect(first.status).toBe(200);
  expect((f.publications[0] as any).expectedRevision).toBeNull();
  const handle = (await f.projects.handle(f.local.id))!;
  expect(handle.manifest().contributions?.main?.revision).toBe(f.getHead()!);
  const base = f.getHead();
  f.setHead(randomUUID());
  expect((await f.app.request(path, { method: "PUT" })).status).toBe(409);
  expect(f.publications).toHaveLength(1);
  expect(handle.manifest().contributions?.main?.revision).toBe(base!);
  expect(await readFile(join(f.local.path, "board.kicad_pcb"), "utf8")).toBe(f.pcb);
});
test("imports into a fresh separate project, pins identity and keeps existing files", async () => {
  const f = await setup();
  f.setHead(randomUUID());
  f.setRole("contributor");
  const route = `/cloud/team-projects/${f.remoteId}/boards/main/import`;
  const one = await f.app.request(route, { method: "POST" });
  expect(one.status).toBe(201);
  const p = (await one.json()) as any;
  const two = await f.app.request(route, { method: "POST" });
  expect(two.status).toBe(201);
  const p2 = (await two.json()) as any;
  expect(p.id).not.toBe(p2.id);
  expect(p.path).not.toBe(p2.path);
  expect(p.path).not.toBe(f.local.path);
  expect(p.manifest.contributions.main.revision).toBe(f.getHead());
  expect(p.manifest.contributionSource.projectId).toBe(f.remoteId);
  expect(await readFile(join(p.path, "board.kicad_pcb"), "utf8")).toBe(f.pcb);
  const result = await f.app.request(`/projects/${p.id}/contributions/main`, { method: "PUT" });
  expect(result.status).toBe(200);
  expect((f.publications[0] as any).expectedRevision).toBe(p.manifest.contributions.main.revision);
  expect(await readFile(join(f.local.path, "board.kicad_pcb"), "utf8")).toBe(f.pcb);
});
test("a server conflict preserves the original receipt and local board", async () => {
  const f = await setup(),
    path = `/projects/${f.local.id}/contributions/main`;
  await f.app.request(path, { method: "PUT" });
  const base = f.getHead();
  f.setFailure();
  expect((await f.app.request(path, { method: "PUT" })).status).toBe(409);
  expect((await f.projects.handle(f.local.id))!.manifest().contributions?.main?.revision).toBe(
    base!,
  );
});
test("sources stay bound to the original project and API, and remote callers cannot import or publish", async () => {
  const f = await setup(),
    handle = (await f.projects.handle(f.local.id))!;
  await handle.updateManifest({
    contributions: {
      main: {
        apiOrigin: "https://another.test",
        projectId: f.remoteId,
        boardId: "main",
        revision: randomUUID(),
      },
    },
  });
  expect(
    (await f.app.request(`/projects/${f.local.id}/contributions/main`, { method: "PUT" })).status,
  ).toBe(409);
  f.remote();
  for (const [url, method] of [
    ["/cloud/team-projects", "GET"],
    [`/cloud/team-projects/${f.remoteId}/boards/main/import`, "POST"],
    [`/projects/${f.local.id}/contributions/main`, "PUT"],
  ])
    expect((await f.app.request(url!, { method })).status).toBe(403);
  expect(f.publications).toHaveLength(0);
});
test("editable collector excludes arbitrary files and detects source mutation and aliases", async () => {
  const f = await setup();
  await writeFile(join(f.local.path, "secret.env"), "PRIVATE_SECRET");
  const h = (await f.projects.handle(f.local.id))!,
    input = await prepareEditableBoard(h, "main");
  expect(Object.keys(input.files)).toEqual(["pcb"]);
  expect(JSON.stringify(input.files)).not.toContain("PRIVATE_SECRET");
  await writeFile(join(f.local.path, "board.kicad_pcb"), f.pcb + "\n");
  await expect(input.verify()).rejects.toThrow("changed");
  await rm(join(f.local.path, "board.kicad_pcb"));
  await symlink(join(f.local.path, "secret.env"), join(f.local.path, "board.kicad_pcb"));
  await expect(prepareEditableBoard(h, "main")).rejects.toThrow("project-owned");
});

test("a missing local source is reported as unavailable without uploading files",async()=>{
 const f=await setup();await rm(join(f.local.path,"board.kicad_pcb"));
 const response=await f.app.request(`/projects/${f.local.id}/contributions/main`,{method:"PUT"});
 expect(response.status).toBe(409);expect((await response.json()as any).error).toBe("source_unavailable");expect(f.publications).toHaveLength(0);
});
