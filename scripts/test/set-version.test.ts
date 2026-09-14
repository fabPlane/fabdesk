import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNumber,
  MOBILE_APP_JSON,
  PACKAGE_FILES,
  setVersion,
  stampMobileConfig,
} from "../set-version";

describe("buildNumber", () => {
  test("is monotonic in the release version order", () => {
    expect(buildNumber("0.3.512")).toBe(300512);
    expect(buildNumber("0.3.513")).toBeGreaterThan(buildNumber("0.3.512"));
    expect(buildNumber("0.4.1")).toBeGreaterThan(buildNumber("0.3.99999"));
    expect(buildNumber("1.0.0")).toBeGreaterThan(buildNumber("0.999.99999"));
  });
  test("rejects what would not fit or is not a version", () => {
    expect(() => buildNumber("0.3.100000")).toThrow();
    expect(() => buildNumber("21.0.0")).toThrow();
    expect(() => buildNumber("v0.3.1")).toThrow();
  });
});

describe("stampMobileConfig", () => {
  test("sets version and both build numbers, keeps everything else", () => {
    const out = stampMobileConfig(
      {
        expo: {
          name: "fabPlane",
          version: "0.1.0",
          ios: { bundleIdentifier: "x", buildNumber: "1" },
          android: { package: "y", versionCode: 1 },
        },
      },
      "0.3.512",
    );
    expect(out.expo).toMatchObject({
      name: "fabPlane",
      version: "0.3.512",
      ios: { bundleIdentifier: "x", buildNumber: "300512" },
      android: { package: "y", versionCode: 300512 },
    });
  });
});

describe("setVersion", () => {
  test("stamps every package.json exactly as before, plus app.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "set-version-"));
    for (const rel of PACKAGE_FILES) {
      await mkdir(join(root, rel, ".."), { recursive: true });
      await writeFile(
        join(root, rel),
        JSON.stringify({ name: rel, version: "0.0.0", private: true }),
      );
    }
    await mkdir(join(root, MOBILE_APP_JSON, ".."), { recursive: true });
    await writeFile(
      join(root, MOBILE_APP_JSON),
      JSON.stringify({ expo: { slug: "m", version: "0.1.0" } }),
    );

    const lines: string[] = [];
    setVersion(root, "0.3.512", (l) => lines.push(l));

    for (const rel of PACKAGE_FILES) {
      const text = await readFile(join(root, rel), "utf8");
      expect(JSON.parse(text)).toEqual({ name: rel, version: "0.3.512", private: true });
      expect(text.endsWith("}\n")).toBe(true);
    }
    const app = JSON.parse(await readFile(join(root, MOBILE_APP_JSON), "utf8")) as {
      expo: Record<string, unknown>;
    };
    expect(app.expo).toEqual({
      slug: "m",
      version: "0.3.512",
      ios: { buildNumber: "300512" },
      android: { versionCode: 300512 },
    });
    expect(lines).toHaveLength(PACKAGE_FILES.length + 1);
  });
});
