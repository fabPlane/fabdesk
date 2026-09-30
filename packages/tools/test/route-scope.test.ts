import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type RouteJobOptions, ToolError } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function harness() {
  const project = await tempProject("route-scope");
  const board = join(project.dir, "board.kicad_pcb");
  const pro = join(project.dir, "board.kicad_pro");
  await writeFile(board, "original board\n");
  await writeFile(pro, "original project\n");
  const base = mockServices([project]);
  const routed: RouteJobOptions[] = [];
  let queued = 0;
  const services = mockServices([project], {
    routeTasks: {
      ...base.routeTasks,
      enqueue: (run, task) => {
        queued++;
        return base.routeTasks.enqueue(run, task);
      },
    },
    design: {
      ...base.design,
      route: async (dir, opts, hooks) => {
        routed.push(opts);
        const result = await base.design.route(dir, opts, hooks);
        await writeFile(join(dir, "board.kicad_pcb"), "routed whole net\n");
        return result;
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const call = (args: Record<string, unknown>) =>
    registry.invoke("route_run", args, (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
  const finish = async (id: string) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const run = services.routeRuns.get(id);
      if (
        run &&
        ["applied", "failed", "not_available", "rejected", "stale"].includes(
          run.application.state,
        ) &&
        ["completed", "failed", "timed_out"].includes(run.state)
      )
        return run;
      await Bun.sleep(5);
    }
    throw new Error("route did not finish");
  };
  return { project, board, pro, services, routed, call, finish, queued: () => queued };
}

describe("routing scope contract", () => {
  const point = { x: 0.5, y: 3 };
  for (const [label, targets] of [
    ["from only", [{ net: "N1", from: point }]],
    ["to only", [{ net: "N1", to: point }]],
    ["endpoint pair", [{ net: "N1", from: point, to: { x: 4, y: 3 } }]],
    ["mixed net and endpoint scope", [{ net: "N1" }, { net: "N1", from: point }]],
  ] as const) {
    test(`rejects ${label} before routing or creating a run`, async () => {
      const h = await harness();
      const before = await readdir(h.project.dir);
      let rejection: unknown;
      try {
        const result = await h.call({ targets });
        // Drain the baseline's wrongly accepted job before checking its effects.
        await h.finish((result.json as { runId: string }).runId);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(ToolError);
      expect((rejection as Error)?.message).toContain("whole-net scope only");
      expect(h.queued()).toBe(0);
      expect(h.routed).toEqual([]);
      expect(h.services.routeRuns.latest(h.project.id)).toBeNull();
      expect(await readFile(h.board, "utf8")).toBe("original board\n");
      expect(await readFile(h.pro, "utf8")).toBe("original project\n");
      expect(await readdir(h.project.dir)).toEqual(before);
    });
  }

  test.each([{ targets: [{ net: "N1" }] }, { onlyConnections: ["N1"] }])(
    "an explicit whole-net request still routes and applies: %j",
    async (args) => {
      const h = await harness();
      const response = await h.call(args);
      const run = await h.finish((response.json as { runId: string }).runId);
      expect(h.queued()).toBe(1);
      expect(h.routed).toHaveLength(1);
      expect(h.routed[0]?.nets).toEqual(["N1"]);
      expect(run.application.state).toBe("applied");
      expect(await readFile(h.board, "utf8")).toBe("routed whole net\n");
      expect(await readFile(h.pro, "utf8")).toBe("original project\n");
    },
  );
});
