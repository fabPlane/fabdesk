import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSharedAuth } from "./shared-auth";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fabdesk-shared-auth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("absent auth stays a shared store when the CLI first saves credentials", () => {
  const source = join(dir, "auth.json");
  const overlay = join(dir, "overlay");
  mkdirSync(overlay);
  const link = join(overlay, "auth.json");
  linkSharedAuth(link, source);
  linkSharedAuth(link, source);
  writeFileSync(link, "fresh credentials");
  expect(readFileSync(source, "utf8")).toBe("fresh credentials");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("an earlier private credential snapshot is preserved and blocks launch", () => {
  const source = join(dir, "auth.json");
  const link = join(dir, "snapshot.json");
  writeFileSync(source, "old refresh token");
  writeFileSync(link, "rotated refresh token");
  expect(() => linkSharedAuth(link, source)).toThrow("private snapshot");
  expect(readFileSync(source, "utf8")).toBe("old refresh token");
  expect(readFileSync(link, "utf8")).toBe("rotated refresh token");
});

test("a link to an unrelated credential store is preserved and rejected", () => {
  const source = join(dir, "auth.json");
  const link = join(dir, "link.json");
  symlinkSync(join(dir, "another.json"), link);
  expect(() => linkSharedAuth(link, source)).toThrow("different store");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});
