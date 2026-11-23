/** board_check on a pre-10 board: refused with the way out; upgrade: true upgrades a checked copy, keeps the old board, onboards. */
import { describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nameBoardNets } from "@fabdesk/board-workflow";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const LEGACY = `(kicad_pcb
	(version 20241229)
	(generator "pcbnew")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(net 0 "")
	(net 1 "A")
	(net 2 "B")
	(footprint "R_0402" (layer "F.Cu") (at 10 10 0)
		(property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
		(property "Value" "10k" (at 0 0 0) (layer "F.Fab"))
		(pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A"))
		(pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "B")))
	(segment
		(start 9.5 10)
		(end 5 10)
		(width 0.25)
		(layer "F.Cu")
		(net 1)
		(uuid "s1")
	)
	(gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))
)
`;

async function setup() {
  const project = await tempProject("bcheck");
  await writeFile(join(project.dir, "board.kicad_pcb"), LEGACY);
  const calls: string[][] = [];
  const base = mockServices([project]);
  // kicad-cli pcb upgrade, faked through the cli's trace hook: names the nets and bumps the version as KiCad 10 does
  const cli = {
    path: "/mock/kicad-cli",
    version: "10.99.0",
    trace: async (input: { command: string[] }) => {
      calls.push(input.command.slice(1));
      const file = input.command[input.command.length - 1]!;
      await writeFile(file, nameBoardNets(await readFile(file, "utf8")).text.replace("(version 20241229)", "(version 20260206)"));
      return { stdout: "Successfully saved board file using the latest format\n", stderr: "", exitCode: 0 };
    },
  };
  const services = { ...base, kicad: { ...base.kicad, resolveCli: async () => cli } };
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const call = (args: Record<string, unknown>) => registry.invoke("board_check", args, (ref) => factory({ def: registry.get("board_check")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} } as never)) as Promise<{ text: string; json: any }>;
  return { project, calls, call };
}

describe("board_check upgrade (pcb upgrade)", () => {
  test("a pre-10 board is refused with the way out, and nothing is written", async () => {
    const { project, calls, call } = await setup();
    await expect(call({})).rejects.toThrow(/pre-10 KiCad file format \(1 copper items name their net by number\).*board_check \{"upgrade": true\}/);
    expect(calls).toEqual([]);
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(LEGACY);
  });
  test("upgrade: true upgrades a copy with KiCad, writes it over the board keeping the previous one, says so, then onboards and measures", async () => {
    const { project, calls, call } = await setup();
    const r = await call({ upgrade: true, parity: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(["pcb", "upgrade", "--force"]);
    expect(r.text).toContain("UPGRADED board.kicad_pcb from the pre-10 KiCad format (1 copper items named their net by number)");
    expect(r.text).toContain("version 20241229 -> 20260206");
    expect(r.text).toContain("previous board: .fabdesk/board/adopt/");
    expect(r.text).toContain("A1-A9:");
    const now = await readFile(join(project.dir, "board.kicad_pcb"), "utf8");
    expect(now).toContain("(version 20260206)");
    expect(now).toContain('(net "A")');
    const adopt = join(project.dir, ".fabdesk", "board", "adopt");
    const [stampDir] = await readdir(adopt);
    expect(await readFile(join(adopt, stampDir!, "before", "board.kicad_pcb"), "utf8")).toBe(LEGACY);
    // a current board: upgrade is a no-op
    calls.length = 0;
    const again = await call({ upgrade: true, parity: false });
    expect(calls).toEqual([]);
    expect(again.text).not.toContain("UPGRADED");
  });
});
