import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectsDirectory } from "./projects-directory";

const homes: string[] = [];
function home() {
  const p = mkdtempSync(join(tmpdir(), "fabdesk-root-"));
  homes.push(p);
  return p;
}
function checkout(path: string) {
  mkdirSync(join(path, "apps", "core"), { recursive: true });
  mkdirSync(join(path, "apps", "desktop"), { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "fabdesk" }));
}
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});

test("a fresh home uses a directory distinct from the conventional source checkout", () => {
  const h = home();
  expect(resolveProjectsDirectory({}, h)).toBe(join(h, "Fabdesk Projects"));
});
for (const name of ["Fabdesk", "fabdesk"]) {
  test(`preserves existing ${name} workspace projects without moving files`, () => {
    const h = home();
    const p = join(h, name);
    mkdirSync(p);
    writeFileSync(join(p, "my-board.kicad_pcb"), "board");
    expect(resolveProjectsDirectory({}, h).toLowerCase()).toBe(p.toLowerCase());
  });
  test(`never implicitly scans a ${name} source checkout`, () => {
    const h = home();
    checkout(join(h, name));
    expect(resolveProjectsDirectory({}, h)).toBe(join(h, "Fabdesk Projects"));
  });
}
test("source checkout symlinks are detected too", () => {
  const h = home();
  checkout(join(h, "source"));
  symlinkSync(join(h, "source"), join(h, "fabdesk"));
  expect(resolveProjectsDirectory({}, h)).toBe(join(h, "Fabdesk Projects"));
});
test("explicit workspace configuration wins, including an intentional checkout", () => {
  const h = home();
  const p = join(h, "fabdesk");
  checkout(p);
  expect(resolveProjectsDirectory({ FABDESK_PROJECTS_DIR: p }, h)).toBe(p);
  expect(resolveProjectsDirectory({ FABDESK_PROJECTS_DIR: "  " }, h)).toBe(
    join(h, "Fabdesk Projects"),
  );
});
test("an occupied fallback requires explicit configuration instead of silently adopting source", () => {
  const h = home();
  checkout(join(h, "Fabdesk Projects"));
  expect(() => resolveProjectsDirectory({}, h)).toThrow("FABDESK_PROJECTS_DIR");
});

test("prefers the current lowercase workspace when both spellings exist", () => {
  const h = home();
  mkdirSync(join(h, "fabdesk"), { recursive: true });
  mkdirSync(join(h, "Fabdesk"), { recursive: true });
  expect(resolveProjectsDirectory({}, h)).toBe(join(h, "fabdesk"));
});
