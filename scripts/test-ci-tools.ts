// Exercise the workflow shell on a runner without preinstalled node or gh.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = { id?: string; name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;
const release = workflow("release");
const security = workflow("security-scan");
const setup = (job: { steps?: Step[] }) => {
  const script = job.steps?.find((step) => step.name === "Set up GitHub CLI for Linux")?.run;
  assert(script, "Linux gh setup is missing");
  return script;
};
const root = mkdtempSync(join(tmpdir(), "fabdesk-ci-tools-"));
const bin = join(root, "bin");
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, "bun"));
// Allow only bootstrap tools; Node and gh are absent even on hosted images.
for (const command of ["curl", "sha256sum", "tar", "mktemp", "gzip", "unzip", "ln"]) {
  const path = Bun.which(command);
  assert(path, `${command} is required to test the Linux bootstrap`);
  symlinkSync(path, join(bin, command));
}
const baseEnv = { ...process.env, PATH: bin, RUNNER_ARCH: "X64" };
function run(script: string, name: string, extra: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const pathFile = join(dir, "github-path");
  writeFileSync(pathFile, "");
  const result = Bun.spawnSync(["/bin/bash", "-e", "-c", script], {
    cwd: dir,
    env: { ...baseEnv, RUNNER_TEMP: dir, GITHUB_PATH: pathFile, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { result, dir, installed: readFileSync(pathFile, "utf8").trim() };
}

try {
  const versionDir = join(root, "version");
  mkdirSync(versionDir);
  writeFileSync(join(versionDir, "package.json"), JSON.stringify({ version: "0.24.3" }));
  const output = join(versionDir, "output");
  const versionScript = release.jobs.version!.steps!.find((step) => step.id === "v")!.run!;
  const versionResult = Bun.spawnSync(
    ["/bin/bash", "-e", "-c", versionScript.replaceAll("${{ github.run_number }}", "139")],
    { cwd: versionDir, env: { ...baseEnv, GITHUB_OUTPUT: output }, stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(versionResult.exitCode, 0, versionResult.stderr.toString());
  assert.equal(readFileSync(output, "utf8"), "version=0.24.139\ntag=v0.24.139\n");
  console.log("PASS version metadata with Bun and no global Node");

  // Download once through the actual workflow shell and verify its pinned digest.
  const scan = run(setup(security.jobs.scan!), "security");
  assert.equal(scan.result.exitCode, 0, scan.result.stderr.toString());
  const executable = join(scan.installed, "gh");
  assert.equal(readFileSync(executable).subarray(0, 4).toString("hex"), "7f454c46");
  if (process.platform === "linux") {
    const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
    assert.equal(version.exitCode, 0, version.stderr.toString());
    assert.match(version.stdout.toString(), /gh version 2\.102\.0/);
  }
  console.log("PASS verified job-local GitHub CLI archive and binary");

  const ci = workflow("ci");
  const bunSetup = ci.jobs.verify!.steps!.find((step) => step.name === "Recover Bun installation through the release API")?.run;
  assert(bunSetup, "Bun recovery setup is missing");
  assert.equal(
    workflow("mobile").jobs.verify!.steps!.find((step) => step.name === "Recover Bun installation through the release API")?.run,
    bunSetup,
    "Mobile verification must use the same verified Bun recovery",
  );
  const recoveredBun = run(bunSetup, "bun-recovery");
  assert.equal(recoveredBun.result.exitCode, 0, recoveredBun.result.stderr.toString());
  const bunExecutable = join(recoveredBun.installed, "bun");
  assert.equal(readFileSync(bunExecutable).subarray(0, 4).toString("hex"), "7f454c46");
  const bunxExecutable = join(recoveredBun.installed, "bunx");
  assert.equal(readlinkSync(bunxExecutable), "bun");
  assert(readFileSync(bunxExecutable).equals(readFileSync(bunExecutable)));
  if (process.platform === "linux") {
    const version = Bun.spawnSync([bunExecutable, "--version"], { stdout: "pipe", stderr: "pipe" });
    assert.equal(version.exitCode, 0, version.stderr.toString());
    assert.equal(version.stdout.toString().trim(), "1.4.0");
    const bunxVersion = Bun.spawnSync([bunxExecutable, "--version"], { stdout: "pipe", stderr: "pipe" });
    assert.equal(bunxVersion.exitCode, 0, bunxVersion.stderr.toString());
    assert.equal(bunxVersion.stdout.toString().trim(), "1.4.0");
  }
  console.log("PASS verified job-local Bun recovery archive and binary");

  // Replay the same trusted archive offline for every release job using the alias.
  rmSync(join(bin, "curl"));
  writeFileSync(join(bin, "curl"), '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -o ]; then /bin/cp "$CI_TEST_ARCHIVE" "$2"; exit; fi\n  shift\ndone\nexit 1\n', { mode: 0o755 });
  const archive = join(scan.installed, "gh.tar.gz");
  for (const job of ["version", "build", "release", "website"]) {
    const installed = run(setup(release.jobs[job]!), `release-${job}`, { CI_TEST_ARCHIVE: archive });
    assert.equal(installed.result.exitCode, 0, installed.result.stderr.toString());
    assert(readFileSync(join(installed.installed, "gh")).equals(readFileSync(executable)));
  }
  console.log("PASS GitHub CLI setup in all four release jobs");

  const badArchive = join(root, "tampered.tar.gz");
  writeFileSync(badArchive, "tampered archive");
  const tampered = run(setup(release.jobs.version!), "tampered", { CI_TEST_ARCHIVE: badArchive });
  assert.notEqual(tampered.result.exitCode, 0);
  assert.equal(tampered.installed, "", "Unverified binary must not enter PATH");
  console.log("PASS checksum mismatch blocks installation");

  const tamperedBun = run(bunSetup, "bun-tampered", { CI_TEST_ARCHIVE: badArchive });
  assert.notEqual(tamperedBun.result.exitCode, 0);
  assert.equal(tamperedBun.installed, "", "Unverified Bun must not enter PATH");
  console.log("PASS Bun checksum mismatch blocks installation");

  const unsupportedBun = run(bunSetup, "bun-unsupported", { RUNNER_ARCH: "ARM64", CI_TEST_ARCHIVE: resolve("missing") });
  assert.notEqual(unsupportedBun.result.exitCode, 0);
  assert.equal(unsupportedBun.installed, "");
  console.log("PASS unsupported Bun architecture fails before installation");

  const unsupported = run(setup(release.jobs.version!), "unsupported", { RUNNER_ARCH: "ARM64", CI_TEST_ARCHIVE: resolve("missing") });
  assert.notEqual(unsupported.result.exitCode, 0);
  assert.equal(unsupported.installed, "");
  console.log("PASS unsupported architecture fails before installation");
} finally {
  rmSync(root, { recursive: true, force: true });
}
