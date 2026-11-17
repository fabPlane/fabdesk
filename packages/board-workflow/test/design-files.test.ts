import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designFileHashes, projectLibraryPaths } from "../src/edit/pipeline";

const sheet = (...refs: string[]) => `(kicad_sch\n${refs.map((r) => `  (sheet (property "Sheetname" "s") (property "Sheetfile" "${r}"))\n`).join("")})\n`;

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-files-"));
  const put = async (rel: string, text: string) => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  };
  await put("board.kicad_pcb", "(kicad_pcb)");
  await put("board.kicad_pro", "{}");
  await put("board.kicad_sch", sheet("sheets/power.kicad_sch"));
  await put("sheets/power.kicad_sch", sheet("deep/ldo.kicad_sch"));
  await put("sheets/deep/ldo.kicad_sch", sheet());
  await put("fp-lib-table", `(fp_lib_table\n  (version 7)\n  (lib (name "Parts")(type "KiCad")(uri "\${KIPRJMOD}/lib/Parts.pretty")(options "")(descr ""))\n  (lib (name "Std")(type "KiCad")(uri "\${KICAD9_FOOTPRINT_DIR}/R.pretty")(options "")(descr ""))\n)\n`);
  await put("sym-lib-table", `(sym_lib_table\n  (version 7)\n  (lib (name "Mine")(type "KiCad")(uri "\${KIPRJMOD}/lib/mine.kicad_sym")(options "")(descr ""))\n)\n`);
  await put("lib/Parts.pretty/R_0402.kicad_mod", "(footprint R_0402)");
  await put("lib/mine.kicad_sym", "(kicad_symbol_lib)");
  await put(".fabdesk/board/requirements/circuit.json", "{}");
  // not design inputs: an archived revision, a vendored library repository, an unreferenced sheet, an autosave
  await put("archive/rev-a/board.kicad_pcb", "(kicad_pcb old)");
  await put("archive/rev-a/board.kicad_sch", sheet());
  await put("vendor/kicad-footprints/Big.pretty/X.kicad_mod", "(footprint X)");
  await put("sheets/unused.kicad_sch", sheet());
  await put("_autosave-board.kicad_sch", sheet());
  return dir;
}

describe("designFileHashes", () => {
  test("lists only the project's own design inputs", async () => {
    const dir = await project();
    try {
      expect(Object.keys(await designFileHashes(dir)).sort()).toEqual([
        ".fabdesk/board/requirements/circuit.json",
        "board.kicad_pcb",
        "board.kicad_pro",
        "board.kicad_sch",
        "fp-lib-table",
        "lib/Parts.pretty/R_0402.kicad_mod",
        "lib/mine.kicad_sym",
        "sheets/deep/ldo.kicad_sch",
        "sheets/power.kicad_sch",
        "sym-lib-table",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a change in an unrelated nested folder does not count; a referenced sheet or project library does", async () => {
    const dir = await project();
    try {
      const before = await designFileHashes(dir);
      await writeFile(join(dir, "archive/rev-a/board.kicad_sch"), sheet("x.kicad_sch"));
      await writeFile(join(dir, "vendor/kicad-footprints/Big.pretty/X.kicad_mod"), "(footprint X2)");
      await writeFile(join(dir, "sheets/unused.kicad_sch"), sheet("y.kicad_sch"));
      expect(await designFileHashes(dir)).toEqual(before);
      await writeFile(join(dir, "sheets/deep/ldo.kicad_sch"), sheet("z.kicad_sch"));
      const sheetChanged = await designFileHashes(dir);
      expect(sheetChanged["sheets/deep/ldo.kicad_sch"]).not.toBe(before["sheets/deep/ldo.kicad_sch"]);
      await writeFile(join(dir, "lib/Parts.pretty/R_0402.kicad_mod"), "(footprint R_0402 v2)");
      await writeFile(join(dir, "lib/mine.kicad_sym"), "(kicad_symbol_lib v2)");
      const libChanged = await designFileHashes(dir);
      expect(libChanged["lib/Parts.pretty/R_0402.kicad_mod"]).not.toBe(sheetChanged["lib/Parts.pretty/R_0402.kicad_mod"]);
      expect(libChanged["lib/mine.kicad_sym"]).not.toBe(sheetChanged["lib/mine.kicad_sym"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a board below the project folder adds its own folder's files", async () => {
    const dir = await project();
    try {
      await mkdir(join(dir, "hw"), { recursive: true });
      await writeFile(join(dir, "hw/panel.kicad_pcb"), "(kicad_pcb panel)");
      await writeFile(join(dir, "hw/panel.kicad_dru"), "(version 1)");
      expect("hw/panel.kicad_pcb" in (await designFileHashes(dir))).toBe(false);
      const withBoard = await designFileHashes(dir, { pcb: "hw/panel.kicad_pcb" });
      expect("hw/panel.kicad_pcb" in withBoard).toBe(true);
      expect("hw/panel.kicad_dru" in withBoard).toBe(true);
      expect("archive/rev-a/board.kicad_pcb" in withBoard).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("library tables: only ${KIPRJMOD} paths inside the project", () => {
    const table = `(fp_lib_table (lib (name "A")(type "KiCad")(uri "\${KIPRJMOD}/a.pretty")) (lib (name "B")(type "KiCad")(uri "$(KIPRJMOD)/b.pretty")) (lib (name "C")(type "KiCad")(uri "/abs/c.pretty")) (lib (name "D")(type "KiCad")(uri "\${KIPRJMOD}/\${OTHER}/d.pretty")))`;
    expect(projectLibraryPaths(table, "/p")).toEqual(["/p/a.pretty", "/p/b.pretty"]);
  });
});
