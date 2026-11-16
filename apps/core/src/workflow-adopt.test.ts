import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptBoard, apiServerEndpoint, diffItems, killTree, normalisedItemJson } from "./workflow-adopt";

const item = (typeName: string, id: string, body: Record<string, unknown>) => ({
  typeName,
  id,
  toJson: () => ({ id: { value: id }, ...body }),
});

describe("adopt comparison", () => {
  test("ignores regenerated child ids and the session board parent", () => {
    const a = item("KOT_PCB_FOOTPRINT", "f1", {
      parent: { value: "board-a" },
      fields: [{ id: { value: "x1" }, name: "LCSC", text: "C1" }],
    });
    const b = item("KOT_PCB_FOOTPRINT", "f1", {
      parent: { value: "board-b" },
      fields: [{ id: { value: "y9" }, name: "LCSC", text: "C1" }],
    });
    expect(normalisedItemJson(a)).toBe(normalisedItemJson(b));
  });

  test("finds removed, added and changed items by type and id", () => {
    const A = new Map([
      ["KOT_PCB_TRACE:t1", item("KOT_PCB_TRACE", "t1", { width: 1 })],
      ["KOT_PCB_TRACE:t2", item("KOT_PCB_TRACE", "t2", { width: 1 })],
      ["KOT_PCB_FOOTPRINT:f1", item("KOT_PCB_FOOTPRINT", "f1", { at: [0, 0] })],
    ]);
    const B = new Map([
      ["KOT_PCB_TRACE:t2", item("KOT_PCB_TRACE", "t2", { width: 1 })],
      ["KOT_PCB_TRACE:t3", item("KOT_PCB_TRACE", "t3", { width: 2 })],
      ["KOT_PCB_FOOTPRINT:f1", item("KOT_PCB_FOOTPRINT", "f1", { at: [1, 0] })],
    ]);
    const d = diffItems(A, B);
    expect(d.summary).toEqual({
      removed: { KOT_PCB_TRACE: 1 },
      added: { KOT_PCB_TRACE: 1 },
      changed: { KOT_PCB_FOOTPRINT: 1 },
    });
    expect(d.removed.map((x) => x.id)).toEqual(["t1"]);
  });
});

describe("adopt server cleanup", () => {
  test("a wrapper kicad-cli that fails to start leaves no server process or temp dir behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adopt-leak-"));
    const board = join(dir, "board.kicad_pcb");
    await writeFile(board, "(kicad_pcb)");
    const pidFile = join(dir, "child.pid");
    // like /usr/bin/kicad-cli-nightly: a shell wrapper; this one starts a long-lived child and exits
    const cli = join(dir, "kicad-cli");
    await writeFile(cli, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nexit 1\n`);
    await chmod(cli, 0o755);
    const before = (await readdir(tmpdir())).filter((f) => f.startsWith("fabdesk-adopt-")).length;
    await expect(
      adoptBoard({ target: board, candidate: board, cli: { path: cli } as never }),
    ).rejects.toThrow(/could not open/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((z) => setTimeout(z, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    const after = (await readdir(tmpdir())).filter((f) => f.startsWith("fabdesk-adopt-")).length;
    expect(after).toBeLessThanOrEqual(before);
  });

  test.skipIf(process.platform === "win32" || !Bun.which("python3"))("a KiCad that drops the connection instead of loading the board: its own output goes into the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adopt-drop-"));
    const board = join(dir, "board.kicad_pcb");
    await writeFile(board, "(kicad_pcb)");
    // listens, takes the connection, says why it cannot load the board and closes (what a KiCad older than the file does)
    const cli = join(dir, "kicad-cli");
    await writeFile(
      cli,
      `#!/bin/sh\npython3 -c '\nimport socket, sys\ns = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1)\nc, _ = s.accept()\nsys.stderr.write("Failed to load board: KiCad was unable to open this file because it was created with a more recent version than the one you are running.\\n"); sys.stderr.flush()\nc.close(); s.close()\n' "$3"\nexit 1\n`,
    );
    await chmod(cli, 0o755);
    const err = await adoptBoard({ target: board, candidate: board, cli: { path: cli } as never }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("--- kicad-cli output ---");
    expect(err?.message).toContain("created with a more recent version than the one you are running");
  });

  test("Windows: the api-server listens on a loopback WebSocket and its process tree is killed with taskkill", () => {
    expect(apiServerEndpoint("win32", "C:\\tmp\\a", 41234)).toMatch(/^ws:\/\/127\.0\.0\.1:41234\/kicad\//);
    expect(apiServerEndpoint("linux", "/tmp/a", 0)).toBe(join("/tmp/a", "api.sock"));
    const calls: Array<[string, string[]]> = [];
    killTree({ pid: 4242 }, "SIGTERM", "win32", (cmd, args) => void calls.push([cmd, args]));
    killTree({ pid: undefined }, "SIGKILL", "win32", (cmd, args) => void calls.push([cmd, args]));
    expect(calls).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]]]);
  });
});
