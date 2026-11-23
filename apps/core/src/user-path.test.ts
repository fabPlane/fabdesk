import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptUserPath,
  mergePath,
  parseShellPath,
  readLoginShellPath,
  shellPathCommand,
  userPathReady,
  wellKnownBinDirs,
} from "./user-path";

const posix = process.platform !== "win32";

describe("mergePath", () => {
  test("a Finder PATH takes the shell's order", () => {
    expect(
      mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/bin:/Users/me/.local/bin", [], ":"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin:/Users/me/.local/bin");
  });

  test("entries only the inherited PATH has stay first", () => {
    expect(mergePath("/venv/bin:/usr/bin", "/opt/homebrew/bin:/usr/bin", [], ":")).toBe(
      "/venv/bin:/opt/homebrew/bin:/usr/bin",
    );
  });

  test("fallbacks go last and nothing repeats", () => {
    expect(mergePath("/usr/bin::/bin", undefined, ["/opt/homebrew/bin", "/bin"], ":")).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin",
    );
    expect(mergePath(undefined, undefined, ["/usr/local/bin"], ":")).toBe("/usr/local/bin");
  });
});

describe("shell PATH", () => {
  test("reads between the markers, ignoring profile output", () => {
    expect(parseShellPath("motd\n__FABDESK_PATH_START__/a:/b__FABDESK_PATH_END__bye")).toBe("/a:/b");
    expect(parseShellPath("no markers")).toBeUndefined();
    expect(parseShellPath("__FABDESK_PATH_START____FABDESK_PATH_END__")).toBeUndefined();
  });

  test("knows POSIX shells and fish, skips the rest", () => {
    expect(shellPathCommand("/bin/zsh")?.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"]);
    expect(shellPathCommand("/opt/homebrew/bin/fish")?.[2]).toContain("string join");
    expect(shellPathCommand("/usr/bin/nu")).toBeUndefined();
  });

  test("well-known folders cover Homebrew on macOS and none on Windows", () => {
    expect(wellKnownBinDirs("/Users/me", "darwin")).toContain("/opt/homebrew/bin");
    expect(wellKnownBinDirs("/home/me", "linux")).toContain(join("/home/me", ".local", "bin"));
    expect(wellKnownBinDirs("C:\\Users\\me", "win32")).toEqual([]);
  });
});

describe.skipIf(!posix)("adoptUserPath", () => {
  let dir: string;
  let shell: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fabdesk-user-path-"));
    // Stands in for a login shell whose profile adds a folder the launcher never had.
    shell = join(dir, "sh");
    writeFileSync(shell, `#!/bin/sh\nPATH="${dir}/tools:$PATH"\nexec /bin/sh -c "$2"\n`);
    chmodSync(shell, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("asks the login shell", async () => {
    expect(await readLoginShellPath({ SHELL: shell, PATH: "/usr/bin:/bin" })).toBe(
      `${dir}/tools:/usr/bin:/bin`,
    );
    expect(await readLoginShellPath({ SHELL: join(dir, "missing-zsh"), PATH: "/usr/bin" })).toBeUndefined();
  });

  test("puts the shell's folders on a launcher PATH", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
    await adoptUserPath(env);
    await userPathReady();
    expect(env["PATH"]?.startsWith(`${dir}/tools:/usr/bin:/bin`)).toBe(true);
  });

  test("FABDESK_USER_PATH=off leaves PATH alone", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin", FABDESK_USER_PATH: "off" };
    await adoptUserPath(env);
    expect(env["PATH"]).toBe("/usr/bin");
  });
});
