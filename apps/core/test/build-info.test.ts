import { describe, expect, test } from "bun:test";
import { buildInfo, resolveBuildInfo } from "../src/build-info";

const git = (out: Record<string, string | null>) => (args: string[]) => out[args.join(" ")] ?? null;
const repo = git({
  "rev-parse --short HEAD": "5067af9",
  "rev-parse --abbrev-ref HEAD": "traditional-v2",
  "status --porcelain --untracked-files=no": " M apps/core/src/serve.ts",
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
});
