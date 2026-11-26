import { expect, test } from "bun:test";
import { macUpdateRelaunch, updateRelaunchArgs } from "./update-relaunch";

test("restart pins the effective profile and only keeps display options from the original invocation", () => {
  const profile = "/QA/quoted 'profile' $(echo wrong)";
  const argv = ["fabPlane", "--user-data-dir", "/old", "fabplane://open?project=another", "--force-renderer-accessibility",
    "--ozone-platform=x11", "--enable-logging", "--", "--disable-gpu"];
  expect(updateRelaunchArgs(profile, argv)).toEqual(["--user-data-dir=" + profile, "--force-renderer-accessibility", "--ozone-platform=x11"]);
});

test("Mac launches the installed bundle using literal arguments outside the shell program", () => {
  const bundle = "/Volumes/é's work/fabPlane.app";
  const exe = bundle + "/Contents/MacOS/fabPlane";
  const profile = "/Users/test/fabPlane $(ignored)";
  const { execPath, args } = macUpdateRelaunch(exe, "0.4.26", updateRelaunchArgs(profile, []));
  expect(execPath).toBe("/bin/sh");
  expect(args.slice(3)).toEqual([exe, bundle, "0.4.26", "--user-data-dir=" + profile]);
  expect(args[1]).not.toContain(profile);
  expect(args[1]).not.toContain(exe);
});
