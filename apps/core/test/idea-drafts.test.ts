import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db";
import { ProjectStore } from "../src/projects";
import { createContextFactory } from "../src/context";
import { TokenSet } from "../src/auth";
import { request_project_creation, coreTools } from "../../../packages/tools/src/tools/core";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { ToolRegistry } from "@fabdesk/tools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fabplane-ideas-"));
  const store = Store.open(join(dir, "db.sqlite")), root = join(dir, "projects");
  const projects = new ProjectStore(store.projects, root, () => {}, { watch: false });
  await projects.init();
  cleanups.push(async () => { projects.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, root, projects };
}

test("drafts persist separately and promotion retains the exact workspace, references and conversation", async () => {
  const { projects, store, root, dir } = await fixture();
  const draft = await projects.create("Untitled idea", undefined, true);
  const oldPath = draft.path;
  await writeFile(join(oldPath, "sketches", "sensor.excalidraw.png"), "exact saved sketch");
  await writeFile(join(oldPath, "NOTES.md"), "USB powered, 20mm");
  const thread = store.threads.create({ projectId: draft.id, agentId: "codex" });
  store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "Please plan my sensor" });
  const restarted = new ProjectStore(store.projects, root, () => {}, { watch: false });
  await restarted.init();
  expect(restarted.summaries().find(p => p.id === draft.id)?.isDraft).toBe(true);
  const destination = join(dir, "chosen"); await mkdir(destination);
  const promoted = await restarted.promoteDraft(draft.id, "USB sensor", destination);
  expect(promoted.id).toBe(draft.id);
  expect(promoted.path).toBe(join(await realpath(destination), "usb-sensor"));
  expect(promoted.manifest.ideaDraft).toBeUndefined();
  expect(promoted.manifest.promotedAt).toBeDefined();
  expect(await readFile(join(promoted.path, "sketches", "sensor.excalidraw.png"), "utf8")).toBe("exact saved sketch");
  expect(await readFile(join(promoted.path, "NOTES.md"), "utf8")).toBe("USB powered, 20mm");
  expect(store.threads.get(thread.id)?.projectId).toBe(draft.id);
  expect(store.threads.messages(thread.id)[0]?.contentMd).toBe("Please plan my sensor");
  expect(await stat(oldPath).catch(() => null)).toBeNull();
  expect(restarted.summaries()).toHaveLength(1);
  expect(restarted.summaries()[0]?.isDraft).toBeUndefined();
  await expect(restarted.promoteDraft(draft.id, "Again")).rejects.toThrow("already became");
  const again = new ProjectStore(store.projects, root, () => {}, { watch: false }); await again.init();
  expect(again.summaries()).toHaveLength(1);
  expect((await again.detail(draft.id))?.path).toBe(promoted.path);
});

test("invalid destination preserves draft; occupied names are never overwritten; concurrent setup cannot duplicate", async () => {
  const { projects, root } = await fixture();
  const draft = await projects.create("Untitled idea", undefined, true);
  await writeFile(join(draft.path, "sketches", "a.png"), "original");
  await expect(projects.promoteDraft(draft.id, "USB sensor", "/definitely/not/a/folder")).rejects.toThrow();
  expect((await projects.detail(draft.id))?.manifest.ideaDraft).toBeDefined();
  await mkdir(join(root, "usb-sensor")); await writeFile(join(root, "usb-sensor", "keep.txt"), "other person");
  const outcomes = await Promise.allSettled([projects.promoteDraft(draft.id, "USB sensor"), projects.promoteDraft(draft.id, "USB sensor")]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(join(root, "usb-sensor", "keep.txt"), "utf8")).toBe("other person");
  expect((await projects.detail(draft.id))?.path).toBe(join(root, "usb-sensor-2"));
});

test("draft tool boundary blocks engineering, global tools and cross-project selectors, but records a setup request", async () => {
  const { projects } = await fixture();
  const draft = await projects.create("Idea", undefined, true), other = await projects.create("Existing");
  const tokens = new TokenSet("draft-test-token");
  const token = tokens.mintRunToken({ runId: "run-draft", threadId: "thread-draft", projectId: draft.id });
  const factory = createContextFactory({ projects, tokens, services: mockServices() as never });
  const registry = new ToolRegistry(); for (const def of coreTools) registry.add(def);
  const call = (name: string, args = {}, auth = token) => registry.invoke(name, args, (projectRef, def) => factory({ token: auth, ...(projectRef ? { projectRef } : {}), def, signal: new AbortController().signal, progress: () => {} }));
  await expect(call("circuit_build", { description: "LED" })).rejects.toThrow();
  await expect(call("project_status")).rejects.toThrow("idea draft");
  await expect(call("load_toolset", { toolset: "circuit" })).rejects.toThrow("idea draft");
  await expect(call("project_status", { project: other.id })).rejects.toThrow("idea draft");
  await expect(call("request_project_creation", { project: other.id, instruction: "Build" })).rejects.toThrow("idea draft");
  await call(request_project_creation.name, { instruction: "Generate the agreed USB sensor schematic" });
  expect((await projects.detail(draft.id))?.manifest.ideaDraft?.requestedBuild).toBe("Generate the agreed USB sensor schematic");
  expect((await projects.detail(draft.id))?.files.some(file => file.path.endsWith(".kicad_pcb"))).toBe(false);
});
