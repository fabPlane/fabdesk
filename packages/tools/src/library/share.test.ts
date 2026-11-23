import { expect, test } from "bun:test";
import { addLibraryFile } from "./store";
import { sharedLibraryItems } from "./share";
import { libraryTestProject } from "./test-project";

test("share excerpts only allowlisted text, never source or env files", async () => {
  const project = await libraryTestProject("library-share-excerpts");
  await addLibraryFile(project, {
    filename: "mcu.md",
    data: Buffer.from("Absolute maximum ratings for the MCU.\n"),
  });
  await addLibraryFile(project, {
    filename: "boot.py",
    data: Buffer.from("SECRET_TOKEN = 'not-for-share'\n"),
  });
  await addLibraryFile(project, {
    filename: ".env",
    data: Buffer.from("AWS_SECRET=should-not-publish\n"),
  });
  const items = await sharedLibraryItems(project);
  const md = items.find((item) => item.path.endsWith("mcu.md"));
  const py = items.find((item) => item.path.endsWith("boot.py"));
  expect(md?.textExcerpt).toContain("Absolute maximum");
  expect(py).toBeDefined();
  expect(py?.textExcerpt).toBe("");
  expect(items.some((item) => item.path.endsWith(".env"))).toBe(false);
  expect(JSON.stringify(items)).not.toContain("SECRET_TOKEN");
  expect(JSON.stringify(items)).not.toContain("AWS_SECRET");
});
