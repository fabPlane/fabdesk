import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareComMarkerStudio, studioCandidates } from "./commarker-studio";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "fabdesk-test-studio-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(platform: NodeJS.Platform) {
  const opened: string[] = [];
  const revealed: string[] = [];
  const clipboard: string[] = [];
  const host = {
    platform, temp: root, userData: join(root, "settings"), candidates: [] as string[],
    pickStudio: async (): Promise<string | undefined> => undefined,
    openApplication: async (path: string) => { opened.push(path); return ""; },
    copyPath: (path: string) => { clipboard.push(path); return true; },
    reveal: (path: string) => { revealed.push(path); },
  };
  return { host, opened, revealed, clipboard };
}

const svg = (value: string) => new TextEncoder().encode(`<svg><title>${value}</title></svg>`);

test("stages the exact bytes independently on concurrent exports of the same filename", async () => {
  const { host, opened, clipboard, revealed } = setup("win32");
  const exe = join(root, "ComMarker_Studio.exe");
  await writeFile(exe, "");
  host.candidates = [exe];
  const [first, second] = await Promise.all([
    prepareComMarkerStudio("copper.svg", svg("first"), host),
    prepareComMarkerStudio("copper.svg", svg("next"), host),
  ]);
  expect(first.opened && second.opened).toBe(true);
  expect(first.path).not.toBe(second.path);
  expect(await readFile(first.path, "utf8")).toContain("first");
  expect(await readFile(second.path, "utf8")).toContain("next");
  expect(opened).toEqual([exe, exe]);
  expect(clipboard.sort()).toEqual([first.path, second.path].sort());
  expect(revealed).toEqual([]);
});

test("remembers a manually chosen macOS application for later imports", async () => {
  const { host, opened } = setup("darwin");
  const bundle = join(root, "ComMarker_Studio.app");
  await mkdir(bundle);
  host.pickStudio = async () => bundle;
  expect((await prepareComMarkerStudio("a.svg", svg("one"), host)).opened).toBe(true);
  host.pickStudio = async () => { throw new Error("Studio should have been remembered"); };
  expect((await prepareComMarkerStudio("b.svg", svg("two"), host)).opened).toBe(true);
  expect(opened).toEqual([bundle, bundle]);
});

test("a canceled picker keeps the file available even if the clipboard is busy", async () => {
  const { host, revealed } = setup("win32");
  host.copyPath = () => false;
  const result = await prepareComMarkerStudio("front.svg", svg("board"), host);
  expect(result).toEqual({ path: revealed[0]!, opened: false, copied: false });
  expect(basename(result.path)).toBe("front.svg");
  expect(await readFile(result.path, "utf8")).toContain("board");
});

test("a stale cached application and a non-Studio selection fall back to the saved artwork", async () => {
  const { host, opened, revealed } = setup("win32");
  await mkdir(host.userData);
  await writeFile(join(host.userData, "commarker-studio-path.txt"), join(root, "missing", "ComMarker_Studio.exe"));
  const other = join(root, "program.exe");
  await writeFile(other, "");
  host.pickStudio = async () => other;
  const result = await prepareComMarkerStudio("front.svg", svg("board"), host);
  expect(opened).toEqual([]);
  expect(revealed).toEqual([result.path]);
  expect(result.opened).toBe(false);
});

test("Windows launch errors retain the SVG and keep a privilege failure out of the success path", async () => {
  const { host, revealed, clipboard } = setup("win32");
  const installed = join(root, "ComMarker_Studio.exe");
  const portable = join(root, "ComMarker Studio.exe");
  await Promise.all([writeFile(installed, ""), writeFile(portable, "")]);
  host.candidates = [installed];
  host.pickStudio = async () => portable;
  const attempts: string[] = [];
  host.openApplication = async (path) => {
    attempts.push(path);
    if (path === installed) return "The requested operation requires elevation.";
    throw new Error("Access is denied.");
  };
  const result = await prepareComMarkerStudio("front.svg", svg("artifact"), host);
  expect(attempts).toEqual([installed, portable]);
  expect(result.opened).toBe(false);
  expect(clipboard).toEqual([result.path]);
  expect(revealed).toEqual([result.path]);
  expect(await readFile(result.path, "utf8")).toContain("artifact");
});

test("rejects directory traversal, alternate output formats and empty data before staging", async () => {
  const { host } = setup("win32");
  for (const filename of ["../plot.svg", "..\\plot.svg", "a.exe", "a.svg:out.svg", "CON.svg"]) {
    await expect(prepareComMarkerStudio(filename, svg("board"), host)).rejects.toThrow("filename");
  }
  await expect(prepareComMarkerStudio("a.svg", new Uint8Array(), host)).rejects.toThrow("empty");
  expect(await readdir(root)).toEqual([]);
});

test("includes the vendor application names for both desktop platforms", () => {
  expect(studioCandidates("darwin", root, {})).toContain(join(root, "Applications", "ComMarker_Studio.app"));
  expect(studioCandidates("win32", root, { ProgramFiles: root })).toContain(join(root, "ComMarker_Studio", "ComMarker_Studio.exe"));
});
