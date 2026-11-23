import { expect, test } from "bun:test";
import {
  defaultLibraryFolder,
  emptyProjectLibraryFile,
  libraryKindForName,
  LibraryEntry,
  PROJECT_LIBRARY_CONTRACT,
  PROJECT_LIBRARY_FILE,
  ProjectLibraryFile,
  SharedLibraryItem,
} from "./project-library";

test("library sidecar lives under files/ next to the board", () => {
  expect(PROJECT_LIBRARY_FILE).toBe("files/library.json");
  expect(emptyProjectLibraryFile("t").contract).toEqual(PROJECT_LIBRARY_CONTRACT);
});

test("kind defaults follow common datasheet and image extensions", () => {
  expect(libraryKindForName("STM32F103.pdf")).toBe("datasheet");
  expect(libraryKindForName("pinout.PNG")).toBe("image");
  expect(libraryKindForName("notes.md")).toBe("research");
  expect(defaultLibraryFolder("datasheet")).toBe("datasheets");
});

test("entries cannot escape the files/ directory", () => {
  const base = {
    id: "fil_abc123",
    title: "Part",
    kind: "datasheet" as const,
    folder: "datasheets",
    tags: [],
    linkedRefs: ["U1"],
    linkedMpns: [],
    addedAt: "t",
    updatedAt: "t",
  };
  expect(LibraryEntry.safeParse({ ...base, path: "files/datasheets/part.pdf" }).success).toBe(true);
  expect(LibraryEntry.safeParse({ ...base, path: "board.kicad_pcb" }).success).toBe(false);
  expect(LibraryEntry.safeParse({ ...base, path: "files/../fabdesk.json" }).success).toBe(false);
});

test("shared items reject local roots and keep excerpts bounded", () => {
  const item = SharedLibraryItem.parse({
    id: "fil_abc123",
    title: "STM32 datasheet",
    path: "files/datasheets/stm32.pdf",
    kind: "datasheet",
    folder: "datasheets",
    tags: ["mcu"],
    linkedRefs: ["U1"],
    linkedMpns: ["STM32F103C8T6"],
    mime: "application/pdf",
    bytes: 1200,
    pageCount: 2,
    textExcerpt: "Absolute maximum ratings",
    preview: null,
  });
  expect(item.textExcerpt).toContain("Absolute");
  expect(
    ProjectLibraryFile.safeParse({
      contract: PROJECT_LIBRARY_CONTRACT,
      updatedAt: "t",
      entries: [],
      home: "/Users/maya",
    }).success,
  ).toBe(false);
});
