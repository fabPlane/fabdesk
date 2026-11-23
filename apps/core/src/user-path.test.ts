import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveBinary } from "@fabdesk/agents";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptUserPath,
  mergePath,
  parseShellPath,
  readLoginShellPath,
  shellPathCommand,
  userPathReady,
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

  test("a profile's background process holding stdout cannot stall the lookup", async () => {
    // Prints nothing useful and leaves a child with the pipe open, as a profile-started daemon would.
    writeFileSync(shell, "#!/bin/sh\nsleep 20 &\nsleep 20\n");
    const started = Date.now();
    expect(await readLoginShellPath({ SHELL: shell, PATH: "/usr/bin:/bin" }, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);

    writeFileSync(shell, `#!/bin/sh\nsleep 20 &\nexec /bin/sh -c "$2"\n`);
    expect(await readLoginShellPath({ SHELL: shell, PATH: "/usr/bin:/bin" }, 10_000)).toBe(
      "/usr/bin:/bin",
    );
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("puts the shell's folders on a launcher PATH", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
    await adoptUserPath(env);
    await userPathReady();
    expect(env["PATH"]?.startsWith(`${dir}/tools:/usr/bin:/bin`)).toBe(true);
  });

  test("FABDESK_USER_PATH=off leaves PATH alone and starts no shell", async () => {
    const ran = join(dir, "shell-ran");
    writeFileSync(shell, `#!/bin/sh\ntouch "${ran}"\nexec /bin/sh -c "$2"\n`);
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin", FABDESK_USER_PATH: "off" };
    await adoptUserPath(env);
    await userPathReady();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(existsSync(ran)).toBe(false);
  });

  test("FABDESK_USER_PATH=off does not turn off detection's common-folder lookup", async () => {
    // The flag is about the daemon's environment; finding a CLI off PATH is detection's own step.
    const cli = join(dir, "fabdesk-test-agent");
    copyFileSync(process.execPath, cli);
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin", FABDESK_USER_PATH: "off" };
    await adoptUserPath(env);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(resolveBinary("fabdesk-test-agent", [dir])).toBe(cli);
  });
});
