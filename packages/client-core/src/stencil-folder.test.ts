import { describe, expect, test } from "bun:test";
import { openStencilFolder } from "./stencil-folder";
import type { ToolRunState } from "./tools";

const local = "http://127.0.0.1:47831";
const done = (path: string): ToolRunState => ({ status: "done", result: { json: { path } } });

describe("openStencilFolder", () => {
  test("opens the actual output directory on Windows and POSIX, including spaces", async () => {
    for (const [path, expected] of [
      ["C:\\My PCB\\exports\\stencil\\F-Paste.stl", "C:\\My PCB\\exports\\stencil"],
      ["C:/My PCB/exports/stencil/B-Paste.stl", "C:/My PCB/exports/stencil"],
      ["/home/me/My PCB/exports/stencil/F-Paste.stl", "/home/me/My PCB/exports/stencil"],
    ]) {
      const opened: string[] = [];
      const state = done(path!);
      expect(await openStencilFolder(state, { openPath: p => { opened.push(p); } }, local)).toBe(state);
      expect(opened).toEqual([expected!]);
    }
  });

  test("does not open a folder before success, for missing paths, or for remote/web hosts", async () => {
    const opened: string[] = [];
    const host = { openPath: (p: string) => { opened.push(p); } };
    for (const status of ["idle", "running", "failed"] as const) {
      await openStencilFolder({ ...done("C:/PCB/exports/stencil/F-Paste.stl"), status }, host, local);
    }
    for (const result of [undefined, null, {}, { json: {} }, { json: { path: "exports/stencil/F-Paste.stl" } }]) {
      await openStencilFolder({ status: "done", result }, host, local);
    }
    await openStencilFolder(done("/remote/exports/stencil/F-Paste.stl"), host, "https://core.example.com");
    await openStencilFolder(done("/remote/exports/stencil/F-Paste.stl"), host, "invalid-url");
    await openStencilFolder(done("C:/PCB/exports/stencil/F-Paste.stl"), {}, local);
    expect(opened).toEqual([]);
  });

  test("folder-opening errors do not turn a successful export into a failed export", async () => {
    const state = done("C:/PCB/exports/stencil/F-Paste.stl");
    const result = await openStencilFolder(state, { openPath: async () => { throw Error("File manager unavailable"); } }, local);
    expect(result.status).toBe("done");
    expect(result.result).toBe(state.result);
    expect(result.note).toContain("Stencil exported, but could not open C:/PCB/exports/stencil");
    expect(result.note).toContain("File manager unavailable");
  });
});
