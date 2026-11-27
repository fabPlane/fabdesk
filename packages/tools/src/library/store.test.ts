import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_LIBRARY_CONTRACT } from "@fabdesk/protocol";
import { addLibraryFile, listLibrary, loadLibraryFile, patchLibraryEntry, removeLibraryEntry } from "./store";
import { libraryTestProject } from "./test-project";

const roots: string[] = [];
afterEach(async () => {
  roots.length = 0;
});

test("does not discover hidden files under files/", async () => {
  const project = await libraryTestProject("library-hidden");
  await mkdir(join(project.dir, "files/datasheets"), { recursive: true });
  await writeFile(join(project.dir, "files/.env"), "SECRET=1\n");
  await writeFile(join(project.dir, "files/datasheets/existing.pdf"), "%PDF-1.4 existing");
  const discovered = await listLibrary(project);
  expect(discovered.map((entry) => entry.path)).toEqual(["files/datasheets/existing.pdf"]);
});

test("discovers files already sitting in files/ and records uploads in library.json", async () => {
  const project = await libraryTestProject("library");
  await mkdir(join(project.dir, "files/datasheets"), { recursive: true });
  await writeFile(join(project.dir, "files/datasheets/existing.pdf"), "%PDF-1.4 existing");
  const discovered = await listLibrary(project);
  expect(discovered.map((entry) => entry.path)).toEqual(["files/datasheets/existing.pdf"]);
  expect(discovered[0]?.kind).toBe("datasheet");
  expect(discovered[0]?.linkedRefs).toEqual([]);

  const added = await addLibraryFile(project, {
    filename: "pinout.png",
    data: new Uint8Array([137, 80, 78, 71]),
    tags: ["connector"],
    linkedRefs: ["J1"],
  });
  expect(added.path).toBe("files/images/pinout.png");
  expect(added.kind).toBe("image");
  expect(added.linkedRefs).toEqual(["J1"]);

  const listed = await listLibrary(project);
  expect(listed).toHaveLength(2);
  const file = await loadLibraryFile(project);
  expect(file.contract).toEqual(PROJECT_LIBRARY_CONTRACT);
  expect(file.entries.some((entry) => entry.path === "files/images/pinout.png")).toBe(true);
});

test("links a datasheet to a component and removes it from disk", async () => {
  const project = await libraryTestProject("library-link");
  const added = await addLibraryFile(project, {
    filename: "mcu.pdf",
    data: Buffer.from("%PDF-1.4 mcu"),
    folder: "datasheets",
  });
  const patched = await patchLibraryEntry(project, added.id, {
    linkedRefs: ["U1"],
    linkedMpns: ["STM32F103C8T6"],
    tags: ["mcu"],
    title: "STM32 datasheet",
  });
  expect(patched.linkedRefs).toEqual(["U1"]);
  expect(patched.title).toBe("STM32 datasheet");
  await removeLibraryEntry(project, added.id);
  expect(await listLibrary(project)).toEqual([]);
});

test("rejects path escape on folder names", async () => {
  const project = await libraryTestProject("library-jail");
  const added = await addLibraryFile(project, {
    filename: "note.md",
    data: Buffer.from("# note\n"),
    folder: "../sketches",
  });
  expect(added.path.startsWith("files/")).toBe(true);
  expect(added.path).not.toContain("..");
});
