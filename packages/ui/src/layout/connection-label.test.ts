import { describe, expect, test } from "bun:test";
import { connectionLabel } from "./connection-label";

describe("connectionLabel", () => {
  test("a signed-in account on a local core shows no label", () => {
    expect(connectionLabel({ connected: true, localCore: true, fabplaneSession: true })).toBeNull();
  });
  test("a local core without a fabPlane account says local", () => {
    expect(connectionLabel({ connected: true, localCore: true, fabplaneSession: false })).toBe("Local mode");
  });
  test("a core on another host is named whatever the account", () => {
    expect(connectionLabel({ connected: true, localCore: false, fabplaneSession: true })).toBe("Remote workspace");
    expect(connectionLabel({ connected: true, localCore: false, fabplaneSession: false })).toBe("Remote workspace");
  });
  test("a lost connection always shows", () => {
    expect(connectionLabel({ connected: false, localCore: true, fabplaneSession: true })).toBe("Reconnecting…");
  });
});
