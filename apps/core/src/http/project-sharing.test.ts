import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManifest } from "@fabdesk/protocol";
import { CloudService, type CloudApi, type ProjectHandle } from "@fabdesk/tools";
import { cloudRoutes } from "./cloud-routes";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<CloudApi> = {}, token: string | null = "owner-token") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "share-route-")));
  roots.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), "native board");
  const manifest = ProjectManifest.parse({
    schema: 1,
    id: "local",
    name: "Controller",
    createdAt: "now",
    updatedAt: "now",
    board: {},
  });
  const handle: ProjectHandle = {
    id: "local",
    name: "Controller",
    dir,
    manifest: () => manifest,
    updateManifest: async () => manifest,
  };
  const tokens: string[] = [];
  const api = overrides as CloudApi;
  const cloud = new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => token,
    orgSetting: () => null,
    api: (options) => {
      tokens.push(options.token);
      return api;
    },
  });
  const app = cloudRoutes({
    cloud: () => cloud,
    projects: { handle: async (id) => (id === "local" ? handle : null) },
    readBom: async () => {
      throw new Error("unused");
    },
    rasterizeSharePreview: async () => ({ png: new Uint8Array() }),
  });
  return { app, tokens };
}
const published = {
  visibility: "unlisted",
  shareId: "share_0123456789abcdef",
  publishedAt: new Date().toISOString(),
  revision: "rev-1",
};
test("restricted publication forwards its explicit access choice and rejects an unconfirmed response", async () => {
  const restricted = { visibility: "restricted", projectId: "2e62e35d-a179-4ef9-a0db-214cd358b2df", publishedAt: published.publishedAt, revision: "r-private" };
  let choice: unknown;
  const { app } = await fixture({
    getProjectShare: async () => restricted,
    publishProjectShare: async (_id, _snapshot, visibility) => { choice = visibility; return visibility === "restricted" ? restricted : published; },
  });
  expect(await (await app.request("/projects/local/share")).json()).toEqual(restricted);
  const response = await app.request("/projects/local/share?visibility=restricted", { method: "PUT" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(restricted);
  expect(choice).toBe("restricted");
  const wrong = await fixture({ publishProjectShare: async () => published });
  expect((await wrong.app.request("/projects/local/share?visibility=restricted", { method: "PUT" })).status).toBe(502);
});
test("publishes only the server-prepared project snapshot and confirms revocation", async () => {
  let payload: unknown;
  const { app } = await fixture({
    getProjectShare: async () => ({ visibility: "private" }),
    publishProjectShare: async (_id, snapshot) => {
      payload = snapshot;
      return published;
    },
    disableProjectShare: async () => ({ visibility: "private" }),
  });
  expect((await app.request("/projects/local/share")).status).toBe(200);
  const response = await app.request("/projects/local/share", {
    method: "PUT",
    body: JSON.stringify({ secret: "ignore client payload" }),
  });
  expect(await response.json()).toEqual(published);
  expect(JSON.stringify(payload)).not.toContain("ignore client payload");
  expect(JSON.stringify(payload)).not.toContain("native board");
  expect(await (await app.request("/projects/local/share", { method: "DELETE" })).json()).toEqual({
    visibility: "private",
  });
});
test("snapshot updates forward update-only mode without a stale visibility choice", async () => {
  const calls: unknown[] = [];
  const { app } = await fixture({ publishProjectShare: async (_id, _snapshot, visibility, options) => { calls.push({ visibility, options }); return published; } });
  expect((await app.request("/projects/local/share?updateOnly=true", { method: "PUT" })).status).toBe(200);
  expect(calls).toEqual([{ visibility: undefined, options: { updateOnly: true } }]);
  expect((await app.request("/projects/local/share?updateOnly=true&visibility=unlisted", { method: "PUT" })).status).toBe(400);
  expect((await app.request("/projects/local/share?updateOnly=false", { method: "PUT" })).status).toBe(400);
  expect(calls).toHaveLength(1);
});
test("owner operations require cloud sign-in but visitors do not", async () => {
  const { app, tokens } = await fixture(
    {
      getProjectShare: async () => ({ visibility: "private" }),
      getSharedProject: async () => ({
        shareId: published.shareId,
        publishedAt: published.publishedAt,
        revision: "r",
        snapshot: {
          schema: "fabplane.project-share.v1",
          name: "Shared",
          capturedAt: published.publishedAt,
          boards: [
            {
              id: "board",
              name: "Board",
              sourceAvailable: true,
              checks: { state: "no-report", findingCount: null },
              preview: null,
            },
          ],
        },
      }),
    },
    null,
  );
  expect((await app.request("/projects/local/share")).status).toBe(401);
  const response = await app.request(`/shared-projects/${published.shareId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(tokens).toEqual([""]);
});
test("older clients show sharing unavailable without claiming the project is private", async () => {
  const { app } = await fixture();
  const response = await app.request("/projects/local/share");
  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: string }).error).toBe("sharing_unavailable");
});
test("access polling is anonymous, uncached and refuses a status from a different link", async () => {
  let wrong = false;
  const { app, tokens } = await fixture(
    {
      getSharedProjectStatus: async () => ({
        shareId: wrong ? "different_0123456789abcdef" : published.shareId,
        publishedAt: published.publishedAt,
        revision: published.revision,
      }),
    },
    null,
  );
  const path = `/shared-projects/${published.shareId}/status`;
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    shareId: published.shareId,
    publishedAt: published.publishedAt,
    revision: published.revision,
  });
  expect(tokens).toEqual([""]);
  wrong = true;
  expect((await app.request(path)).status).toBe(502);
});
test("concurrent changes cannot race publish against disabling sharing", async () => {
  let finish!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { app } = await fixture({
    publishProjectShare: async () => {
      started();
      await waiting;
      return published;
    },
    disableProjectShare: async () => ({ visibility: "private" }),
  });
  const publish = app.request("/projects/local/share", { method: "PUT" });
  await startedPromise;
  expect((await app.request("/projects/local/share", { method: "DELETE" })).status).toBe(409);
  finish();
  expect((await publish).status).toBe(200);
});

test("delegated callers cannot change public visibility", async () => {
  const cloud = new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => "owner",
    orgSetting: () => null,
    api: () => {
      throw new Error("Cloud must not be called");
    },
  });
  const app = cloudRoutes({
    cloud: () => cloud,
    projects: { handle: async () => null },
    readBom: async () => {
      throw new Error("unused");
    },
    rasterizeSharePreview: async () => ({ png: new Uint8Array() }),
    canManageSharing: () => false,
  });
  expect((await app.request("/projects/local/share", { method: "PUT" })).status).toBe(403);
  expect((await app.request("/projects/local/share", { method: "DELETE" })).status).toBe(403);
});
