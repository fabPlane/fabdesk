import { describe, expect, test } from "bun:test";
import { decideMediaPermission, rendererMayUseMicrophone } from "./media-permission";

describe("microphone permission", () => {
  test("the app window may use the mic; a foreign page may not", () => {
    expect(decideMediaPermission("media", "file:///Applications/fabPlane.app/Contents/Resources/out/renderer/index.html")).toBe(true);
    expect(decideMediaPermission("microphone", "http://localhost:5173/")).toBe(true);
    expect(decideMediaPermission("media", "https://evil.example/")).toBe(false);
    expect(decideMediaPermission("notifications", "http://localhost:5173/")).toBe(false);
  });

  test("empty or junk URLs are denied", () => {
    expect(rendererMayUseMicrophone("")).toBe(false);
    expect(rendererMayUseMicrophone("not a url")).toBe(false);
  });
});
