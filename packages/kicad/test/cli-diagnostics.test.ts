import { expect, test } from "bun:test";
import { KicadCliError, runKicadCli } from "../src/cli";

const cli = { path: process.execPath, version: "test-version" };

async function failure(script: string): Promise<KicadCliError> {
  try {
    await runKicadCli(cli, ["--eval", script]);
  } catch (error) {
    expect(error).toBeInstanceOf(KicadCliError);
    return error as KicadCliError;
  }
  throw new Error("Expected CLI failure");
}

test("whitespace stderr does not hide the CLI's stdout diagnostic", async () => {
  const error = await failure('console.error("  "); console.log("Unable to load board"); process.exit(58)');
  expect(error.message).toEndWith("failed (58): Unable to load board");
  expect(error.result.exitCode).toBe(58);
});

test("silent failures identify the KiCad version and runtime", async () => {
  const error = await failure("process.exit(58)");
  expect(error.message).toEndWith(`failed (58): KiCad test-version exited without diagnostic output on ${process.platform}/${process.arch}`);
  expect(error.result).toEqual({ stdout: "", stderr: "", exitCode: 58 });
});

test("stderr retains precedence when it contains a diagnostic", async () => {
  const error = await failure('console.log("Rendering"); console.error("Invalid board"); process.exit(3)');
  expect(error.message).toEndWith("failed (3): Invalid board");
});

test("tolerateExit still returns a silent failure", async () => {
  const result = await runKicadCli(cli, ["--eval", "process.exit(58)"], { tolerateExit: true });
  expect(result.exitCode).toBe(58);
});
