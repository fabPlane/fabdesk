import { describe, expect, test } from "bun:test";
import { buildInfo, changedBeyondVersion, resolveBuildInfo, worktreeDirty } from "../src/build-info";

const git = (out: Record<string, string | null>) => (args: string[]) => out[args.join(" ")] ?? null;
const repo = git({
  "rev-parse --short HEAD": "5067af9",
  "rev-parse --abbrev-ref HEAD": "traditional-v2",
  "diff --name-only HEAD": "apps/core/src/serve.ts",
  "rev-parse --show-toplevel": "/repo",
});

describe("build info", () => {
  test("a checkout is a dev build with its commit, branch and dirty flag from git", () => {
    expect(resolveBuildInfo({ version: "0.2.0", channel: "public", baked: { compiled: false }, env: {}, git: repo })).toEqual({
      version: "0.2.0", kind: "dev", label: null, commit: "5067af9", branch: "traditional-v2", dirty: true,
      channel: "public", builtAt: null,
    });
  });

  test("a label makes a candidate", () => {
    const b = resolveBuildInfo({ version: "0.2.0", channel: "internal", baked: { compiled: false }, env: { FABDESK_BUILD_LABEL: " traditional v2 " }, git: repo });
    expect(b).toMatchObject({ kind: "candidate", label: "traditional-v2", channel: "internal" });
  });

  test("a compiled binary is a release with the baked commit; git is not consulted", () => {
    const b = resolveBuildInfo({
      version: "0.2.1", channel: "public", env: {},
      baked: { compiled: true, commit: "33d68bc", branch: "main", dirty: false, builtAt: "2026-09-29T00:00:00.000Z" },
      git: () => { throw new Error("git must not run for a release"); },
    });
    expect(b).toEqual({ version: "0.2.1", kind: "release", label: null, commit: "33d68bc", branch: "main", dirty: false, channel: "public", builtAt: "2026-09-29T00:00:00.000Z" });
  });

  test("no git leaves the commit unknown", () => {
    expect(resolveBuildInfo({ version: "0.2.0", channel: "public", baked: { compiled: false }, env: {}, git: () => null }))
      .toMatchObject({ kind: "dev", commit: null, branch: null, dirty: null });
  });

  test("this checkout resolves to its own commit", () => {
    const b = buildInfo();
    expect(b.kind === "dev" || b.kind === "candidate").toBe(true);
    expect(b.commit).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("dirty ignores only the release version stamp, even when set-version reformats", () => {
    const head = '{\n  "expo": {\n    "version": "0.1.0",\n    "ios": { "buildNumber": "1" },\n    "android": { "versionCode": 1, "permissions": ["CAMERA"] }\n  }\n}\n';
    const stamped = JSON.stringify({ expo: { version: "0.3.512", ios: { buildNumber: "300512" }, android: { versionCode: 300512, permissions: ["CAMERA"] } } }, null, 2);
    expect(changedBeyondVersion("apps/mobile/app.json", head, stamped)).toBe(false);
    expect(changedBeyondVersion("apps/core/package.json", '{"name":"a","version":"0.2.0"}', '{\n "name": "a",\n "version": "0.3.1"\n}')).toBe(false);
    // Anything else is a change: another field in a stamped file, or any other file.
    expect(changedBeyondVersion("apps/core/package.json", '{"name":"a","version":"0.2.0"}', '{"name":"b","version":"0.2.0"}')).toBe(true);
    expect(changedBeyondVersion("apps/core/src/log.ts", "a", "b")).toBe(true);

    const files: Record<string, string> = { "/repo/package.json": '{"version":"0.3.1"}' };
    const gitWith = (names: string) => git({ "diff --name-only HEAD": names, "rev-parse --show-toplevel": "/repo", "show HEAD:package.json": '{"version":"0.2.0"}' });
    const read = (p: string) => files[p] ?? null;
    expect(worktreeDirty(gitWith(""), read)).toBe(false);
    expect(worktreeDirty(gitWith("package.json"), read)).toBe(false);
    expect(worktreeDirty(gitWith("package.json\napps/core/src/log.ts"), read)).toBe(true);
    expect(worktreeDirty(() => null, read)).toBeNull();
  });
});
