#!/usr/bin/env bun
/**
 * Rejects broken installers before they are uploaded. Beyond checksums, each package is opened and
 * the app inside is exercised: the DMG is mounted and its bundle signature checked, the bundled
 * `fabdesk-core` binary is executed (`version`), zips/AppImages/debs are extracted, Windows
 * installers are tested as archives. Exit code 1 on any failure; writes SHA256SUMS-<target>.txt.
 *
 *   bun run scripts/verify-installers.ts release-out --target bun-darwin-arm64
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCadBackend } from "../apps/desktop/src/main/cad-supervisor";
import { resolvePcbBackend } from "../apps/desktop/src/main/pcb-supervisor";

const dir = process.argv[2] ?? "release-out";
const target = process.argv[process.argv.indexOf("--target") + 1] ?? "";
/** Arch the installers were built for (from --target bun-<os>-<arch>); "" when unknown. */
const targetArch = /-(arm64|x64)$/.exec(target)?.[1] ?? "";
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const failures: string[] = [];
const fail = (msg: string) => {
  console.error(`::error::${msg}`);
  failures.push(msg);
};

function run(
  cmd: string[],
  opts: { cwd?: string; allowFail?: boolean } = {},
): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${new TextDecoder().decode(p.stdout)}${new TextDecoder().decode(p.stderr)}`;
  if (p.exitCode !== 0 && !opts.allowFail)
    console.error(out.trim().split("\n").slice(-8).join("\n"));
  return { ok: p.exitCode === 0, out };
}

function checkCore(bin: string, label: string): void {
  if (!existsSync(bin)) return fail(`${label}: bundled core missing at ${bin}`);
  if (targetArch && targetArch !== hostArch) {
    // Foreign-arch binary (the x64 build verified on an arm64 macOS 14 runner): Rosetta there lacks
    // AVX2, so Bun binaries crash. Check the slice is right and leave execution to the VM tests.
    const archs =
      process.platform === "darwin"
        ? run(["lipo", "-archs", bin], { allowFail: true }).out.trim()
        : run(["file", bin], { allowFail: true }).out;
    const want = targetArch === "x64" ? /x86_64|x86-64/ : /arm64|aarch64/;
    if (!want.test(archs))
      fail(`${label}: core is not a ${targetArch} binary (${archs.trim().slice(0, 80)})`);
    else console.log(`${label}: core is ${targetArch} (not executed on a ${hostArch} host)`);
    return;
  }
  const r = run([bin, "version"]);
  if (!r.ok || !/\d+\.\d+\.\d+/.test(r.out))
    fail(`${label}: fabdesk-core version failed: ${r.out.trim().slice(0, 200)}`);
  else console.log(`${label}: core ${r.out.trim().split("\n")[0]}`);
}

/** Exercise the same manifest/path resolution that runs during packaged desktop startup. */
function checkPcbBundle(resourcesDir: string, label: string): void {
  try {
    const backend = resolvePcbBackend({ packaged: true, resourcesPath: resourcesDir, env: {} });
    if (!backend)
      return fail(`${label}: bundled PCB manifest missing under ${join(resourcesDir, "pcb")}`);
    console.log(`${label}: PCB bundle ${backend.command}`);
  } catch (error) {
    fail(
      `${label}: bundled PCB manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Require a real engine, then smoke FCStd/STEP and bridge authentication on native hosts. */
function checkCadBundle(resourcesDir: string, label: string): void {
  if (!existsSync(join(resourcesDir, "cad"))) {
    console.log(`${label}: CAD is optional; runtime downloads separately with consent`);
    return;
  }
  try {
    const backend = resolveCadBackend({ packaged: true, resourcesPath: resourcesDir, env: {} });
    if (!backend) throw new Error("native CAD bundle missing");
    if (targetArch && targetArch !== hostArch) {
      console.log(
        `${label}: foreign-arch CAD bundle resolved; execution requires its native runner`,
      );
      return;
    }
    const result = run([
      process.execPath,
      resolve(import.meta.dir, "smoke-cad-bundle.ts"),
      join(resourcesDir, "cad/bundle.json"),
    ]);
    if (!result.ok) throw new Error(result.out.trim().slice(-1500));
    console.log(`${label}: native CAD smoke ${result.out.trim().split("\n").at(-1)}`);
  } catch (error) {
    fail(
      `${label}: native CAD package failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Soft-warn (or fail when FABDESK_REQUIRE_BUNDLED_KICAD=1) if Resources/kicad is missing. */
function checkBundledKicad(resourcesDir: string, label: string): void {
  const root = join(resourcesDir, "kicad");
  const candidates =
    process.platform === "darwin"
      ? [
          join(root, "KiCad.app", "Contents", "MacOS", "kicad-cli"),
          join(root, "kicad-cli"),
          join(root, "kicad-cli", "kicad-cli"),
        ]
      : process.platform === "win32"
        ? [
            join(root, "bin", "kicad-cli.exe"),
            join(root, "kicad-cli", "bin", "kicad-cli.exe"),
            join(root, "kicad-cli.exe"),
          ]
        : [
            join(root, "kicad-cli"),
            join(root, "kicad-cli", "kicad-cli"),
            join(root, "bin", "kicad-cli"),
          ];
  // Must be a file: nightly archives use a top-level `kicad-cli/` directory of the same name.
  const hit = candidates.find((p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (hit) {
    console.log(`${label}: bundled KiCad at ${hit}`);
    return;
  }
  const msg = `${label}: bundled KiCad missing under ${root} (stage with scripts/stage-kicad-bundle.ts)`;
  if (process.env["FABDESK_REQUIRE_BUNDLED_KICAD"] === "1") fail(msg);
  else console.warn(`::warning::${msg}`);
}

function checkMacApp(app: string, label: string): void {
  if (!existsSync(join(app, "Contents", "Info.plist")))
    return fail(`${label}: no app bundle at ${app}`);
  const sig = run(["codesign", "--verify", "--deep", "--strict", app]);
  if (!sig.ok) fail(`${label}: codesign verify failed`);
  if (process.env["APPLE_ID"]) {
    // Signing secrets were present, so the release must be Developer ID signed and notarized (stapled).
    const info = run(["codesign", "-dv", "--verbose=2", app], { allowFail: true }).out;
    if (!/Authority=Developer ID Application/.test(info))
      fail(`${label}: not signed with a Developer ID Application certificate`);
    const st = run(["xcrun", "stapler", "validate", app], { allowFail: true });
    if (!st.ok)
      fail(`${label}: notarization ticket not stapled (${st.out.trim().split("\n").pop()})`);
    else console.log(`${label}: Developer ID signed, notarization ticket stapled`);
  }
  const resources = join(app, "Contents", "Resources");
  checkCore(join(resources, "core", "fabdesk-core"), label);
  checkBundledKicad(resources, label);
  checkPcbBundle(resources, label);
  checkCadBundle(resources, label);
  if (!run(["codesign", "--verify", "--deep", "--strict", app]).ok)
    fail(`${label}: native CAD execution modified sealed app resources`);
}

function verifyDmg(file: string): void {
  const v = run(["hdiutil", "verify", file]);
  if (!v.ok) return fail(`${file}: hdiutil verify failed (image corrupt)`);
  const mnt = mkdtempSync(join(tmpdir(), "fabdesk-dmg-"));
  const a = run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mnt, file]);
  if (!a.ok) return fail(`${file}: hdiutil attach failed`);
  try {
    const app = readdirSync(mnt).find((n) => n.endsWith(".app"));
    if (!app) fail(`${file}: no .app inside the image`);
    else checkMacApp(join(mnt, app), file);
  } finally {
    run(["hdiutil", "detach", "-quiet", mnt], { allowFail: true });
  }
}

function verifyZip(file: string): void {
  const t = run(["unzip", "-tq", file]);
  if (!t.ok) return fail(`${file}: zip test failed`);
  if (process.platform !== "darwin") return;
  const out = mkdtempSync(join(tmpdir(), "fabdesk-zip-"));
  try {
    const x = run(["ditto", "-x", "-k", file, out]);
    if (!x.ok) return fail(`${file}: extract failed`);
    const app = readdirSync(out).find((n) => n.endsWith(".app"));
    if (!app) fail(`${file}: no .app inside the zip`);
    else checkMacApp(join(out, app), file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function verifyAppImage(file: string): void {
  const out = mkdtempSync(join(tmpdir(), "fabdesk-appimage-"));
  const abs = resolve(file);
  try {
    const x = run([
      "bash",
      "-c",
      `chmod +x "${abs}" && cd "${out}" && "${abs}" --appimage-extract >/dev/null`,
    ]);
    if (!x.ok) return fail(`${file}: --appimage-extract failed`);
    const resources = join(out, "squashfs-root", "resources");
    checkCore(join(resources, "core", "fabdesk-core"), file);
    checkBundledKicad(resources, file);
    checkPcbBundle(resources, file);
    checkCadBundle(resources, file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function verifyDeb(file: string): void {
  const out = mkdtempSync(join(tmpdir(), "fabdesk-deb-"));
  try {
    const x = run(["dpkg-deb", "-x", file, out]);
    if (!x.ok) return fail(`${file}: dpkg-deb extract failed`);
    const core = run([
      "bash",
      "-c",
      `find "${out}" -path '*/resources/core/fabdesk-core' | head -1`,
    ]).out.trim();
    if (!core) fail(`${file}: bundled core missing`);
    else {
      checkCore(core, file);
      const resources = resolve(core, "..", "..");
      checkBundledKicad(resources, file);
      checkPcbBundle(resources, file);
      checkCadBundle(resources, file);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function verifyExe(file: string): void {
  // NSIS installers are 7-Zip-readable archives; a CRC failure here means a corrupt download later.
  const t = run(["7z", "t", file]);
  if (!t.ok) return fail(`${file}: 7z archive test failed`);
  // electron-builder nests the app in $PLUGINSDIR/app-64.7z; open that to reach the bundled core.
  const listing = run(["7z", "l", file]).out;
  const payload = /(\S*app-(?:64|32)\.7z)\s*$/m.exec(listing)?.[1];
  if (!payload) {
    if (!/resources[\\/]core[\\/]fabdesk-core\.exe/.test(listing))
      fail(`${file}: bundled core missing from installer`);
    return;
  }
  const out = mkdtempSync(join(tmpdir(), "fabdesk-exe-"));
  try {
    const x = run(["7z", "e", "-y", `-o${out}`, file, payload]);
    const inner = join(out, "app-64.7z");
    const innerPath = existsSync(inner) ? inner : join(out, "app-32.7z");
    if (!x.ok || !existsSync(innerPath)) return fail(`${file}: could not extract ${payload}`);
    const il = run(["7z", "l", innerPath]).out;
    if (!/resources[\\/]core[\\/]fabdesk-core\.exe/.test(il))
      return fail(`${file}: bundled core missing from ${payload}`);
    const c = run(["7z", "e", "-y", `-o${out}`, innerPath, "resources/core/fabdesk-core.exe"]);
    if (!c.ok) return fail(`${file}: could not extract the bundled core`);
    if (process.platform === "win32") checkCore(join(out, "fabdesk-core.exe"), file);
    else console.log(`${file}: core present in ${payload} (not executed on ${process.platform})`);
    const pcb = run(["7z", "x", "-y", `-o${out}`, innerPath, "resources/pcb/*"]);
    if (!pcb.ok) return fail(`${file}: could not extract the bundled PCB backend`);
    checkPcbBundle(join(out, "resources"), file);
    if (/resources[\\/]cad[\\/]/.test(il)) {
      const cad = run(["7z", "x", "-y", `-o${out}`, innerPath, "resources/cad/*"]);
      if (!cad.ok) return fail(`${file}: could not extract the bundled CAD runtime`);
    }
    checkCadBundle(join(out, "resources"), file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const files = readdirSync(dir)
  .filter((f) => statSync(join(dir, f)).isFile() && !f.startsWith("SHA256SUMS"))
  .sort();
if (files.length === 0) fail(`no installers found in ${dir}`);
const sums: string[] = [];
for (const f of files) {
  const path = join(dir, f);
  const lower = f.toLowerCase();
  console.log(`\n== ${f} (${statSync(path).size} bytes)`);
  if (lower.endsWith(".dmg")) verifyDmg(path);
  else if (lower.endsWith(".zip")) verifyZip(path);
  else if (lower.endsWith(".appimage")) verifyAppImage(path);
  else if (lower.endsWith(".deb")) verifyDeb(path);
  else if (lower.endsWith(".exe")) verifyExe(path);
  sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${f}`);
}
writeFileSync(join(dir, `SHA256SUMS-${target || process.platform}.txt`), `${sums.join("\n")}\n`);
console.log(`\n${sums.join("\n")}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} installer check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${files.length} installers verified`);
