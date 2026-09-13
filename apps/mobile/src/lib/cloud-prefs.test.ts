import { describe, expect, test } from "bun:test";
import { cloudToPrefs, prefsToCloud, reconcilePrefs, type LocalPrefs } from "./cloud-prefs";

const local: LocalPrefs = {
  appearance: "light",
  haptics: true,
  keepAwake: true,
  updatedAt: 10,
};

describe("prefsToCloud / cloudToPrefs", () => {
  test("round-trips the phone-local fields", () => {
    expect(cloudToPrefs(prefsToCloud(local), local)).toEqual(local);
  });

  test("fills missing remote fields from local", () => {
    expect(cloudToPrefs({ schema: 1, updatedAt: 20, appearance: "dark" }, local)).toEqual({
      appearance: "dark",
      haptics: true,
      keepAwake: true,
      updatedAt: 20,
    });
  });
});

describe("reconcilePrefs", () => {
  test("pushes local when the account is empty", () => {
    expect(reconcilePrefs(local, null)).toEqual({ next: local, push: true });
  });

  test("applies a newer remote document", () => {
    const { next, push } = reconcilePrefs(local, {
      schema: 1,
      updatedAt: 50,
      appearance: "dark",
      haptics: false,
    });
    expect(push).toBe(false);
    expect(next).toEqual({
      appearance: "dark",
      haptics: false,
      keepAwake: true,
      updatedAt: 50,
    });
  });
});
