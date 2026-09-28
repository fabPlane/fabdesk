import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectRevision } from "./project-revisions";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-revision-test-"));
  directories.push(directory);
  await writeFile(join(directory, "board.kicad_pro"), "{}\n");
  await writeFile(join(directory, "board.kicad_pcb"), "pcb-v1\n");
  await writeFile(join(directory, "design.py"), "print('v1')\n");
  return directory;
}

const validation = {
  structural: "pass" as const,
  evidenceLevel: "measured" as const,
  toolchain: { kicadCli: "/bundle/kicad-cli", version: "10.99.0" },
  checks: [{ artifact: "board.kicad_pcb", status: "pass" as const, detail: "reopened" }],
};

describe("project revision boundary", () => {
  test("checkpoints without accepting and advances one pointer only after validation", async () => {
    const directory = await project();
    let output = "",
      errors = "",
      validations = 0;
    const deps = {
      cwd: () => directory,
      validate: async () => {
        validations++;
        await writeFile(join(directory, "board.kicad_prl"), "generated user state\n");
        return validation;
      },
      out: (text: string) => {
        output += text;
      },
      err: (text: string) => {
        errors += text;
      },
    };
    expect(await runProjectRevision({ action: "checkpoint", label: "before layout" }, deps)).toBe(
      0,
    );
    expect(validations).toBe(0);
    const checkpoint = JSON.parse(output);
    expect(checkpoint.status).toBe("checkpointed");
    expect(await Bun.file(join(directory, ".fabdesk/revisions/accepted.json")).exists()).toBe(
      false,
    );

    output = "";
    expect(await runProjectRevision({ action: "accept" }, deps)).toBe(0);
    expect(validations).toBe(1);
    const accepted = JSON.parse(
      await readFile(join(directory, ".fabdesk/revisions/accepted.json"), "utf8"),
    );
    expect(accepted.revision).toBe(checkpoint.revision);
    expect(accepted.validation.toolchain.version).toBe("10.99.0");
    expect(errors).toBe("");
  });

  test("reports changes and recoverably discards to the accepted revision", async () => {
    const directory = await project();
    let output = "";
    const deps = {
      cwd: () => directory,
      validate: async () => validation,
      out: (text: string) => {
        output += text;
      },
      err: () => {},
    };
    expect(await runProjectRevision({ action: "accept" }, deps)).toBe(0);
    output = "";
    await writeFile(join(directory, "board.kicad_pcb"), "pcb-v2\n");
    await writeFile(join(directory, "notes.txt"), "candidate-only\n");
    expect(await runProjectRevision({ action: "status" }, deps)).toBe(1);
    const changed = JSON.parse(output);
    expect(changed.changes.modified).toEqual(["board.kicad_pcb"]);
    expect(changed.changes.added).toEqual(["notes.txt"]);

    output = "";
    expect(await runProjectRevision({ action: "discard" }, deps)).toBe(0);
    const discarded = JSON.parse(output);
    expect(await readFile(join(directory, "board.kicad_pcb"), "utf8")).toBe("pcb-v1\n");
    expect(await Bun.file(join(directory, "notes.txt")).exists()).toBe(false);
    expect(await Bun.file(join(directory, discarded.displacedFiles, "notes.txt")).text()).toBe(
      "candidate-only\n",
    );
    output = "";
    expect(await runProjectRevision({ action: "status" }, deps)).toBe(0);
    expect(JSON.parse(output).status).toBe("clean");
  });

  test("a validation failure does not advance the accepted pointer", async () => {
    const directory = await project();
    let error = "";
    const code = await runProjectRevision(
      { action: "accept" },
      {
        cwd: () => directory,
        validate: async () => {
          throw new Error("native reopen failed");
        },
        out: () => {},
        err: (text) => {
          error += text;
        },
      },
    );
    expect(code).toBe(1);
    expect(error).toContain("native reopen failed");
    expect(await Bun.file(join(directory, ".fabdesk/revisions/accepted.json")).exists()).toBe(
      false,
    );
  });

  test("a candidate change during validation does not advance the accepted pointer", async () => {
    const directory = await project();
    let error = "";
    const code = await runProjectRevision(
      { action: "accept" },
      {
        cwd: () => directory,
        validate: async () => {
          await writeFile(join(directory, "board.kicad_pcb"), "changed-during-validation\n");
          return validation;
        },
        out: () => {},
        err: (text) => {
          error += text;
        },
      },
    );
    expect(code).toBe(1);
    expect(error).toContain("changed during validation or snapshot");
    expect(await Bun.file(join(directory, ".fabdesk/revisions/accepted.json")).exists()).toBe(
      false,
    );
  });
});
