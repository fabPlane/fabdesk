import { expect, test } from "bun:test";
import { installDebianUpdate } from "./update-deb";

const binary = "/opt/fabPlane/fabplane", file = "/home/maker/a folder/update.deb";
const next = "0.4.27", current = "0.4.26";

function manager({ owner = "fabplane", asset = `fabplane\t${next}\tamd64`, final = next, code = 0, initial = current } = {}) {
  const calls: Array<[string, string[]]> = [];
  let attempted = false;
  async function run(command: string, args: string[]) {
    calls.push([command, args]);
    switch (command) {
      case "/usr/bin/dpkg-query": return args[0] === "--search" ? `${owner}: ${binary}` : `installed\t${attempted ? final : initial}\tamd64`;
      case "/usr/bin/dpkg-deb": return asset;
      case "/usr/bin/dpkg": return "";
      case "/usr/bin/pkexec":
        attempted = true;
        if (code) throw Object.assign(new Error("authorization error"), { code });
        return "";
      default: throw new Error(`Unexpected command ${command}`);
    }
  }
  return { run, calls };
}

test("upgrades only the package owning this executable, awaits authorization and confirms the installed version", async () => {
  const { run, calls } = manager();
  await installDebianUpdate(file, binary, next, "x64", run);
  expect(calls.find(([c]) => c.endsWith("/pkexec"))?.[1]).toEqual(["--disable-internal-agent", "/usr/bin/apt-get", "--assume-yes", "--only-upgrade", "--no-remove", "install", file]);
  expect(calls.at(-1)?.[0]).toBe("/usr/bin/dpkg-query");
  const alreadyUpdated = manager({ initial: next });
  await installDebianUpdate(file, binary, next, "x64", alreadyUpdated.run);
  expect(alreadyUpdated.calls.some(([c]) => c.endsWith("/pkexec"))).toBe(false);
});

test("wrong package identity, target or architecture never asks for privileges", async () => {
  for (const options of [{ owner: "other" }, { asset: "fabplane\t0.4.26\tamd64" }, { asset: `fabplane\t${next}\tarm64` }]) {
    const { run, calls } = manager(options);
    await expect(installDebianUpdate(file, binary, next, "x64", run)).rejects.toThrow("does not match");
    expect(calls.some(([c]) => c.endsWith("/pkexec"))).toBe(false);
  }
});

test("a canceled/denied authorization or unchanged installed package never reports success", async () => {
  await expect(installDebianUpdate(file, binary, next, "x64", manager({ code: 126 }).run)).rejects.toThrow("canceled");
  await expect(installDebianUpdate(file, binary, next, "x64", manager({ code: 127 }).run)).rejects.toThrow("authorize");
  await expect(installDebianUpdate(file, binary, next, "x64", manager({ final: current }).run)).rejects.toThrow("did not apply");
});
