import { describe, expect, test } from "bun:test";
import { usageRemoteBackupEnabled } from "../src/usage-backup-env";

describe("usageRemoteBackupEnabled", () => {
  test("unset means on", () => {
    expect(usageRemoteBackupEnabled({})).toBe(true);
    expect(usageRemoteBackupEnabled({ PATH: "/usr/bin" })).toBe(true);
  });

  test.each(["0", "false", "off", "no", "", " FALSE ", "Off", "NO"])(
    "explicit off value %j disables upload",
    (value) => {
      expect(usageRemoteBackupEnabled({ FABDESK_USAGE_REMOTE_BACKUP: value })).toBe(false);
    },
  );

  test.each(["1", "true", "yes", "on"])("explicit on value %j enables upload", (value) => {
    expect(usageRemoteBackupEnabled({ FABDESK_USAGE_REMOTE_BACKUP: value })).toBe(true);
  });
});
