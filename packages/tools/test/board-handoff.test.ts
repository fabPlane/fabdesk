import { describe, expect, test } from "bun:test";
import { BOARD_HANDOFF_NOTE, withBoardHandoff } from "../src/tools/board-handoff";
import { allTools } from "../src/tools/index";

type T = { handler: (i: unknown, c: unknown) => Promise<{ text: string }> };
const tool = (name: string, out: { text: string; isError?: boolean }) => ({ name, handler: async () => out }) as never;
const ctx = (enabled: string[] = ["core", "circuit"]) => {
  const set = new Set(enabled);
  return { set, ctx: { session: { enabledToolsets: () => [...set], enableToolset: (id: string) => void set.add(id) } } as never };
};

describe("withBoardHandoff", () => {
  test("a successful build switches the board toolset on and says so", async () => {
    const c = ctx();
    const out = await (withBoardHandoff(tool("circuit_build", { text: "built" })) as never as T).handler({}, c.ctx);
    expect(c.set.has("board")).toBe(true);
    expect(out.text).toBe(`built\n\n${BOARD_HANDOFF_NOTE}`);
  });
  test("a rejected build, an already loaded set and other tools change nothing", async () => {
    const bad = ctx();
    await (withBoardHandoff(tool("circuit_build", { text: "no", isError: true })) as never as T).handler({}, bad.ctx);
    expect(bad.set.has("board")).toBe(false);
    const loaded = ctx(["core", "board"]);
    expect((await (withBoardHandoff(tool("pcb_update_from_schematic", { text: "ok" })) as never as T).handler({}, loaded.ctx)).text).toBe("ok");
    const other = ctx();
    await (withBoardHandoff(tool("verify_drc", { text: "ok" })) as never as T).handler({}, other.ctx);
    expect(other.set.has("board")).toBe(false);
  });
  test("the real registry has the build tools and board_job", () => {
    for (const name of ["circuit_build", "pcb_update_from_schematic", "board_job"]) expect(allTools.some((t) => t.name === name)).toBe(true);
  });
});
