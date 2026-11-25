import { describe, expect, test } from "bun:test";
import { connectionLabel } from "./connection-label";

describe("connectionLabel", () => {
  test("fabPlane mode on a local core shows no label", () => {
    expect(connectionLabel({ connected: true, localCore: true, authMode: "fabplane" })).toBeNull();
  });
  test("local auth on a local core says local", () => {
    expect(connectionLabel({ connected: true, localCore: true, authMode: "local" })).toBe("Local");
  });
  test("unknown auth state is not reported as local", () => {
    expect(connectionLabel({ connected: true, localCore: true, authMode: undefined })).toBeNull();
  });
  test("a core on another host is named whatever the auth mode", () => {
    expect(connectionLabel({ connected: true, localCore: false, authMode: "fabplane" })).toBe("Remote workspace");
    expect(connectionLabel({ connected: true, localCore: false, authMode: "local" })).toBe("Remote workspace");
  });
  test("a lost connection always shows", () => {
    expect(connectionLabel({ connected: false, localCore: true, authMode: "fabplane" })).toBe("Reconnecting…");
  });
});
