import { describe, expect, test } from "bun:test";
import { packagedKicadEnv } from "./packaged-kicad";
import { join } from "node:path";

describe("packagedKicadEnv", () => {
  test("points the core at Resources/kicad", () => {
    expect(packagedKicadEnv("/App/Contents/Resources")).toEqual({
      FABDESK_RESOURCES: "/App/Contents/Resources",
      FABDESK_BUNDLED_KICAD: join("/App/Contents/Resources", "kicad"),
    });
  });
});
