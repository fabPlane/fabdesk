import { expect, test } from "bun:test";
import type { CoreClient } from "./CoreClient";
import {
  currentPcbDisplays,
  loadPcbDisplay,
  refreshPcbDisplays,
  pcbReadinessResult,
  type PcbDisplay,
} from "./pcb-display";

test("readiness accepts synchronous and wrapped tool responses and rejects errors", () => {
  const json = { exporter: null, suggested: null, boards: [], needsSetup: true };
  expect(pcbReadinessResult({ ok: true, json })).toEqual(json);
  expect(pcbReadinessResult({ result: { json } })).toEqual(json);
  for (const response of [null, { jobId: "pending" }, { isError: true, json }, { json: {} }])
    expect(() => pcbReadinessResult(response)).toThrow("Setup check unavailable");
});

test("model requests deduplicate, refresh on demand and reject mismatched revisions", async () => {
  let calls = 0;
  const client = {
    baseUrl: "test-display",
    callTool: async (_name: string, args: Record<string, string>) => {
      calls++;
      return {
        result: {
          json: {
            modelPath: "renders/board.glb",
            pcbRevision: args.expectedPcbRevision,
            coverage: { loaded: 0, total: 0, missing: [] },
            warnings: [],
          },
        },
      };
    },
    readFileBlob: async () => new Blob(["model"]),
  } as unknown as CoreClient;
  const a = loadPcbDisplay(client, "p", "board.kicad_pcb", "r1");
  expect(loadPcbDisplay(client, "p", "board.kicad_pcb", "r1")).toBe(a);
  await a;
  await loadPcbDisplay(client, "p", "board.kicad_pcb", "r2");
  await loadPcbDisplay(client, "p", "board.kicad_pcb", "r2", true);
  expect(calls).toBe(3);
  client.callTool = async () =>
    ({ result: { json: { modelPath: "old.glb", pcbRevision: "old" } } }) as never;
  await expect(loadPcbDisplay(client, "p", "board.kicad_pcb", "r3")).rejects.toThrow(
    "does not match",
  );
});

const display = (revision = "r1"): PcbDisplay => ({
  modelPath: "renders/board.glb",
  pcbRevision: revision,
  coverage: { loaded: 0, total: 0, missing: [] },
  warnings: [],
  data: new ArrayBuffer(4),
});
const boards = ["a", "b", "c"].map((path) => ({ path, pcbRevision: "r1" }));
function fakeClient(name: string, callTool: CoreClient["callTool"]) {
  return {
    baseUrl: name,
    callTool,
    readFileBlob: async () => new Blob(["mesh"]),
  } as unknown as CoreClient;
}

test("slow and failed refreshes retain every already loaded same-revision board", async () => {
  const previous = { projectId: "p", models: { a: display(), b: display(), c: display() } };
  const updates: Record<string, PcbDisplay>[] = [];
  const errors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = fakeClient("refresh-retains", async (_name, args) => {
    if ((args as { boardPath: string }).boardPath === "b") {
      await gate;
      throw Error("temporarily offline");
    }
    return { result: { json: display() } } as never;
  });
  const work = refreshPcbDisplays(client, "p", boards, {
    previous,
    refresh: true,
    cancelled: () => false,
    publish: (models, error) => {
      updates.push(models);
      errors.push(error);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(updates.length).toBe(2);
  expect(updates.at(-1)!.b).toBe(previous.models.b);
  release();
  await work;
  for (const models of updates) expect(Object.keys(models).sort()).toEqual(["a", "b", "c"]);
  expect(updates.at(-1)!.b).toBe(previous.models.b);
  expect(errors.at(-1)).toContain("Keeping the loaded model");
});

test("selection changes and reactivation reuse models without another export", async () => {
  let calls = 0;
  const client = fakeClient("reuse-existing", async () => {
    calls++;
    throw Error("unexpected export");
  });
  const previous = { projectId: "p", models: { a: display(), b: display(), c: display() } };
  const published: string[][] = [];
  await refreshPcbDisplays(client, "p", [boards[2]!, boards[0]!], {
    previous,
    refresh: false,
    cancelled: () => false,
    publish: (models) => published.push(Object.keys(models)),
  });
  expect(calls).toBe(0);
  expect(published).toEqual([["c", "a"]]);
});

test("revision changes, removed boards and other projects never retain stale geometry", async () => {
  const previous = { projectId: "p", models: { a: display(), b: display() } };
  const changed = [{ path: "a", pcbRevision: "r2" }];
  expect(currentPcbDisplays(previous, "p", changed)).toEqual({});
  expect(currentPcbDisplays(previous, "another-project", boards)).toEqual({});
  const updates: Record<string, PcbDisplay>[] = [];
  await refreshPcbDisplays(
    fakeClient("revision-failed", async () => {
      throw Error("offline");
    }),
    "p",
    changed,
    {
      previous,
      refresh: false,
      cancelled: () => false,
      publish: (models) => updates.push(models),
    },
  );
  expect(updates).toEqual([{}, {}]);
});

test("cancelled loads cannot publish into the next project or keep exporting remaining boards", async () => {
  let cancelled = false,
    calls = 0;
  const updates: Record<string, PcbDisplay>[] = [];
  await refreshPcbDisplays(
    fakeClient("cancel-refresh", async () => {
      calls++;
      cancelled = true;
      return { result: { json: display() } } as never;
    }),
    "p",
    boards,
    {
      previous: { projectId: "p", models: {} },
      refresh: false,
      cancelled: () => cancelled,
      publish: (models) => updates.push(models),
    },
  );
  expect(updates).toEqual([{}]);
  expect(calls).toBe(1);
});

test("a failed explicit refresh keeps the successful cache for reopening the viewer", async () => {
  let fail = false;
  const client = fakeClient("retain-cache", async () => {
    if (fail) throw Error("offline");
    return { result: { json: display() } } as never;
  });
  const original = await loadPcbDisplay(client, "p", "a", "r1");
  fail = true;
  await expect(loadPcbDisplay(client, "p", "a", "r1", true)).rejects.toThrow("offline");
  expect(await loadPcbDisplay(client, "p", "a", "r1")).toBe(original);
});
