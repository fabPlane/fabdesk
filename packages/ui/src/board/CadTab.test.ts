import { describe, expect, test } from "bun:test";
import { CAD_FRAME_SANDBOX } from "./CadTab";

describe("CAD frame sandbox", () => {
  test("lets the fab_cad SPA run at its own origin and nothing that escapes the frame", () => {
    const tokens = CAD_FRAME_SANDBOX.split(" ");
    for (const needed of ["allow-scripts", "allow-same-origin"]) expect(tokens).toContain(needed);
    for (const t of tokens) expect(t).not.toMatch(/top-navigation|popups-to-escape-sandbox/);
  });
});
