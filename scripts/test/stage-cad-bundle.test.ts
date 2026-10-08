import { describe, expect, test } from "bun:test";
import { validateRuntime } from "../stage-cad-bundle";

describe("native CAD release input", () => {
  const runtime = {
    format: 1 as const,
    target: "darwin-arm64",
    freecadCommit: "pinned",
    apiServer: "MacOS/FreeCADApiServer",
    pythonHome: "Frameworks/Python.framework/Versions/3.12",
  };
  test("requires the exact native target and protocol source commit", () => {
    expect(() => validateRuntime(runtime, "darwin-arm64", "pinned")).not.toThrow();
    expect(() => validateRuntime(runtime, "linux-x64", "pinned")).toThrow(/must match/);
    expect(() => validateRuntime(runtime, "darwin-arm64", "different")).toThrow(/must match/);
  });
  test("rejects a mock engine and external runtime paths", () => {
    expect(() =>
      validateRuntime({ ...runtime, apiServer: "mock-server" }, "darwin-arm64", "pinned"),
    ).toThrow(/real FreeCAD/);
    for (const pythonHome of ["/opt/homebrew/python", "../outside", "C:\\Python"]) {
      expect(() => validateRuntime({ ...runtime, pythonHome }, "darwin-arm64", "pinned")).toThrow(
        /within/,
      );
    }
  });
});
