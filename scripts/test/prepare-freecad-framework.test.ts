import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "prepare-freecad-macos.py");

test("restores a codesign-valid Python.framework from Homebrew's altinstall layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "py-framework-"));
  const outside = join(root, "cellar-python");
  await writeFile(outside, "mach-o-python");
  const framework = join(root, "Python.framework");
  const version = join(framework, "Versions", "3.12");
  await mkdir(join(version, "lib"), { recursive: true });
  await mkdir(join(version, "include", "python3.12"), { recursive: true });
  await writeFile(join(version, "lib", "libpython3.12.dylib"), "dylib");
  await writeFile(join(version, "include", "python3.12", "Python.h"), "");
  await symlink("include/python3.12", join(version, "Headers"));
  await symlink(outside, join(version, "Python"));
  const driver = `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("prep", ${JSON.stringify(script)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
framework = Path(${JSON.stringify(framework)})
mod.normalize_python_framework(framework, "3.12")
mod.normalize_python_framework(framework, "3.12")
`;
  try {
    const ran = Bun.spawnSync(["python3", "-c", driver]);
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.toString() || ran.stdout.toString());
    }
    expect(await readlink(join(framework, "Versions", "Current"))).toBe("3.12");
    expect(await readlink(join(framework, "Python"))).toBe("Versions/Current/Python");
    expect(await readlink(join(framework, "Resources"))).toBe("Versions/Current/Resources");
    expect(await readlink(join(framework, "Headers"))).toBe("Versions/Current/Headers");
    expect((await lstat(join(version, "Python"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(version, "Python"), "utf8")).toBe("mach-o-python");
    const plist = await readFile(join(framework, "Resources", "Info.plist"), "utf8");
    expect(plist).toContain("<string>FMWK</string>");
    expect(plist).toContain("<string>Python</string>");
    expect((await lstat(join(framework, "Versions", "Current"))).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("links a missing framework executable at the in-bundle libpython", async () => {
  const root = await mkdtemp(join(tmpdir(), "py-framework-"));
  const framework = join(root, "Python.framework");
  const version = join(framework, "Versions", "3.12");
  await mkdir(join(version, "lib"), { recursive: true });
  await mkdir(join(version, "Resources"), { recursive: true });
  await writeFile(join(version, "lib", "libpython3.12.dylib"), "dylib");
  await writeFile(
    join(version, "Resources", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Python</string>
</dict></plist>
`,
  );
  const driver = `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("prep", ${JSON.stringify(script)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.normalize_python_framework(Path(${JSON.stringify(framework)}), "3.12")
`;
  try {
    const ran = Bun.spawnSync(["python3", "-c", driver]);
    if (ran.exitCode !== 0) throw new Error(ran.stderr.toString() || ran.stdout.toString());
    expect(await readlink(join(version, "Python"))).toBe("lib/libpython3.12.dylib");
    const plist = await readFile(join(version, "Resources", "Info.plist"), "utf8");
    expect(plist).toContain("CFBundlePackageType");
    expect(plist).toContain("CFBundleExecutable");
    expect(plist).toContain("CFBundleName");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
