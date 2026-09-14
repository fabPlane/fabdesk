import { describe, expect, test } from "bun:test";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import { FpPcbSessions } from "../src/fp-pcb-session";

/** A KiCad stand-in: library commands answer only once a project is open, like the api-server. */
function fakeKicad(opts: { projectOpen: boolean }) {
  let projectOpen = opts.projectOpen;
  const calls: string[] = [];
  const kicad = {
    projectInfo: async () => {
      calls.push("projectInfo");
      if (!projectOpen) throw new Error("GetProjectInfo: AS_BAD_REQUEST - no project is open");
      return { kicadProPath: "/tmp/x.kicad_pro", files: [] };
    },
    newProject: async (path: string) => {
      calls.push(`newProject ${path.endsWith(".kicad_pro") ? "ok" : path}`);
      projectOpen = true;
      return {};
    },
    libraries: {
      nicknames: async (type: string) => {
        calls.push(`nicknames ${type}`);
        if (!projectOpen) throw new Error("GetLibraryTables: AS_UNHANDLED - no handler available");
        return ["Package_TO_SOT_SMD", "Resistor_SMD"];
      },
      entries: async (_type: string, nickname: string, filter: string) => {
        calls.push(`entries ${nickname} ${filter}`);
        return nickname === "Package_TO_SOT_SMD" && /sot-23-5/.test(filter)
          ? [{ name: "SOT-23-5", description: "5-pin SOT-23" }, { name: "SOT-23-5_HandSoldering" }]
          : [];
      },
    },
  };
  return { kicad, calls };
}

function sessionsFor(kicad: unknown): FpPcbSessions {
  const session = async () => ({ id: "s1", kicad, ws: {}, path: null });
  const withRetry = async (_dir: string, fn: (s: unknown) => Promise<unknown>) =>
    fn(await session());
  return { session, withRetry } as unknown as FpPcbSessions;
}

describe("searchFootprints", () => {
  test("gives the bare library session a scratch project before asking for library tables", async () => {
    const { kicad, calls } = fakeKicad({ projectOpen: false });
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: sessionsFor(kicad) });
    const hits = await design.searchFootprints("SOT-23-5", 5);
    expect(hits.map((h) => h.libId)).toEqual([
      "Package_TO_SOT_SMD:SOT-23-5",
      "Package_TO_SOT_SMD:SOT-23-5_HandSoldering",
    ]);
    expect(calls.slice(0, 3)).toEqual(["projectInfo", "newProject ok", "nicknames footprint"]);
    // The project stays open on the shared session: the second search creates nothing.
    await design.searchFootprints("R_0603", 5);
    expect(calls.filter((c) => c.startsWith("newProject"))).toHaveLength(1);
  });

  test("leaves a session that already holds a project alone", async () => {
    const { kicad, calls } = fakeKicad({ projectOpen: true });
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: sessionsFor(kicad) });
    await design.searchFootprints("SOT-23-5", 5);
    expect(calls.some((c) => c.startsWith("newProject"))).toBe(false);
  });
});

describe("searchFootprints after a bridge restart", () => {
  test("a gone library session is reconnected once and the search retried", async () => {
    const { kicad } = fakeKicad({ projectOpen: true });
    let attempts = 0;
    const gone = {
      ...kicad,
      libraries: {
        ...kicad.libraries,
        nicknames: async (type: string) => {
          attempts++;
          if (attempts === 1)
            throw new Error(
              "WebSocket ws://127.0.0.1:4020/ws?session=x closed (code 1006: Connection ended)",
            );
          return kicad.libraries.nicknames(type);
        },
      },
    };
    const sessions = new FpPcbSessions(() => ({}) as never);
    let releases = 0;
    sessions.session = async () => ({
      id: "s1",
      kicad: gone as never,
      ws: {} as never,
      path: null,
    });
    sessions.release = async () => {
      releases++;
    };
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });
    const hits = await design.searchFootprints("SOT-23-5", 5);
    expect(attempts).toBe(2);
    expect(releases).toBe(1);
    expect(hits[0]?.libId).toBe("Package_TO_SOT_SMD:SOT-23-5");
  });

  test("an entries call interrupted by a bridge restart retries the complete search", async () => {
    const { kicad } = fakeKicad({ projectOpen: true });
    let attempts = 0;
    const gone = {
      ...kicad,
      libraries: {
        ...kicad.libraries,
        entries: async (...args: Parameters<typeof kicad.libraries.entries>) => {
          attempts++;
          if (attempts === 1) throw new Error("WebSocket closed (code 1006: Connection ended)");
          return kicad.libraries.entries(...args);
        },
      },
    };
    const sessions = new FpPcbSessions(() => ({}) as never);
    sessions.session = async () => ({
      id: "s1",
      kicad: gone as never,
      ws: {} as never,
      path: null,
    });
    sessions.release = async () => {};
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });
    expect((await design.searchFootprints("SOT-23-5", 5))[0]?.libId).toBe(
      "Package_TO_SOT_SMD:SOT-23-5",
    );
    expect(attempts).toBeGreaterThan(1);
  });
});
