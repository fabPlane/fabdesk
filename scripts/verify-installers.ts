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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? "release-out";
const target = process.argv[process.argv.indexOf("--target") + 1] ?? "";
const failures: string[] = [];
const fail = (msg: string) => {
  console.error(`::error::${msg}`);
  failures.push(msg);
};

function run(cmd: string[], opts: { cwd?: string; allowFail?: boolean } = {}): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${new TextDecoder().decode(p.stdout)}${new TextDecoder().decode(p.stderr)}`;
  if (p.exitCode !== 0 && !opts.allowFail) console.error(out.trim().split("\n").slice(-8).join("\n"));
  return { ok: p.exitCode === 0, out };
}

function checkCore(bin: string, label: string): void {
  if (!existsSync(bin)) return fail(`${label}: bundled core missing at ${bin}`);
  const r = run([bin, "version"]);
  if (!r.ok || !/\d+\.\d+\.\d+/.test(r.out)) fail(`${label}: fabdesk-core version failed: ${r.out.trim().slice(0, 200)}`);
  else console.log(`${label}: core ${r.out.trim().split("\n")[0]}`);
}

function checkMacApp(app: string, label: string): void {
  if (!existsSync(join(app, "Contents", "Info.plist"))) return fail(`${label}: no app bundle at ${app}`);
  const sig = run(["codesign", "--verify", "--deep", "--strict", app]);
  if (!sig.ok) fail(`${label}: codesign verify failed`);
  checkCore(join(app, "Contents", "Resources", "core", "fabdesk-core"), label);
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
  try {
    const x = run(["bash", "-c", `chmod +x "${file}" && cd "${out}" && "${file}" --appimage-extract >/dev/null`]);
    if (!x.ok) return fail(`${file}: --appimage-extract failed`);
    checkCore(join(out, "squashfs-root", "resources", "core", "fabdesk-core"), file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function verifyDeb(file: string): void {
  const out = mkdtempSync(join(tmpdir(), "fabdesk-deb-"));
  try {
    const x = run(["dpkg-deb", "-x", file, out]);
    if (!x.ok) return fail(`${file}: dpkg-deb extract failed`);
    const core = run(["bash", "-c", `find "${out}" -path '*/resources/core/fabdesk-core' | head -1`]).out.trim();
    if (!core) fail(`${file}: bundled core missing`);
    else checkCore(core, file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function verifyExe(file: string): void {
  // NSIS installers are 7-Zip-readable archives; a CRC failure here means a corrupt download later.
  const t = run(["7z", "t", file]);
  if (!t.ok) return fail(`${file}: 7z archive test failed`);
  if (!/resources[\\/]core[\\/]fabdesk-core\.exe/.test(run(["7z", "l", file]).out)) fail(`${file}: bundled core missing from installer`);
}

const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && !f.startsWith("SHA256SUMS")).sort();
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
