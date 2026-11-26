import { describe, expect, test } from "bun:test";
import { withoutNativeMinidumps } from "./sentry-integrations";

describe("Sentry integration privacy", () => {
  test.each(["SentryMinidump", "ElectronMinidump"])("removes %s", (name) => {
    const defaults = [{ name }];
    expect(withoutNativeMinidumps(defaults)).toEqual([]);
    expect(defaults).toEqual([{ name }]);
  });

  test("preserves the order and identity of JavaScript reporting integrations", () => {
    const uncaughtException = { name: "OnUncaughtException" };
    const linkedErrors = { name: "LinkedErrors" };
    const defaults = [
      { name: "SentryMinidump" },
      uncaughtException,
      { name: "ElectronMinidump" },
      linkedErrors,
    ];
    const filtered = withoutNativeMinidumps(defaults);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(uncaughtException);
    expect(filtered[1]).toBe(linkedErrors);
  });
});
