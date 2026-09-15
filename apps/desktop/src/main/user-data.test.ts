import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isVacantUserData,
  migrateLegacyUserData,
  PREVIOUS_PRODUCT_USER_DATA,
  TITLECASE_PRODUCT_USER_DATA,
} from "./user-data";

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fabplane-userdata-"));
}

describe("migrateLegacyUserData", () => {
  test("moves Fabdesk onto an empty fabPlane path", async () => {
    const root = await sandbox();
    const previous = join(root, PREVIOUS_PRODUCT_USER_DATA);
    const next = join(root, "fabPlane");
    mkdirSync(previous);
    writeFileSync(join(previous, "daemon.json"), '{"ok":true}');
    expect(migrateLegacyUserData(next)).toBe(previous);
    expect(readFileSync(join(next, "daemon.json"), "utf8")).toBe('{"ok":true}');
    expect(existsSync(previous)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("moves title-case Fabplane onto fabPlane", async () => {
    const root = await sandbox();
    const previous = join(root, TITLECASE_PRODUCT_USER_DATA);
    const next = join(root, "fabPlane");
    mkdirSync(previous);
    writeFileSync(join(previous, "daemon.json"), '{"ok":true}');
    const distinctEntries = !existsSync(next);
    expect(migrateLegacyUserData(next)).toBe(distinctEntries ? previous : null);
    expect(existsSync(join(next, "daemon.json"))).toBe(true);
    if (distinctEntries) expect(existsSync(previous)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("moves @fabdesk/desktop when Fabdesk is absent", async () => {
    const root = await sandbox();
    const scoped = join(root, "@fabdesk", "desktop");
    const next = join(root, "fabPlane");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, "prefs.json"), "{}");
    expect(migrateLegacyUserData(next)).toBe(scoped);
    expect(existsSync(join(next, "prefs.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("prefers Fabdesk over the scoped package path", async () => {
    const root = await sandbox();
    const previous = join(root, PREVIOUS_PRODUCT_USER_DATA);
    const scoped = join(root, "@fabdesk", "desktop");
    const next = join(root, "fabPlane");
    mkdirSync(previous);
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(previous, "from.txt"), "fabdesk");
    writeFileSync(join(scoped, "from.txt"), "scoped");
    expect(migrateLegacyUserData(next)).toBe(previous);
    expect(readFileSync(join(next, "from.txt"), "utf8")).toBe("fabdesk");
    expect(existsSync(scoped)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("leaves an already-populated fabPlane path alone", async () => {
    const root = await sandbox();
    const previous = join(root, PREVIOUS_PRODUCT_USER_DATA);
    const next = join(root, "fabPlane");
    mkdirSync(previous);
    mkdirSync(next);
    writeFileSync(join(previous, "old.txt"), "old");
    writeFileSync(join(next, "new.txt"), "new");
    expect(migrateLegacyUserData(next)).toBeNull();
    expect(existsSync(join(previous, "old.txt"))).toBe(true);
    expect(existsSync(join(next, "old.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("migrates onto an empty destination directory", async () => {
    const root = await sandbox();
    const previous = join(root, PREVIOUS_PRODUCT_USER_DATA);
    const next = join(root, "fabPlane");
    mkdirSync(previous);
    mkdirSync(next);
    writeFileSync(join(previous, "daemon.json"), "{}");
    expect(isVacantUserData(next)).toBe(true);
    expect(migrateLegacyUserData(next)).toBe(previous);
    expect(existsSync(join(next, "daemon.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
