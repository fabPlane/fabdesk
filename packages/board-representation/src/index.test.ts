import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, cp, readFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInputs, refresh, inspect, packet } from "./index";
import { findKicadCli } from "@fabdesk/kicad";

test("nested board captures same-stem sources, library bytes, absence and outside changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "representation-inputs-"));
  try {
    await mkdir(join(root, "native", "local.pretty"), { recursive: true });
    await writeFile(
      join(root, "native", "design.kicad_pcb"),
      "invalid native board for manifest test",
    );
    await writeFile(join(root, "native", "local.pretty", "A.kicad_mod"), "first");
    await writeFile(
      join(root, "native", "fp-lib-table"),
      '(fp_lib_table (lib (name "Local")(type "KiCad")(uri "${KIPRJMOD}/local.pretty")))',
    );
    const a = await captureInputs(root, "native/design.kicad_pcb");
    expect(a.manifest["native/design.kicad_pro"]).toBeNull();
    expect(a.manifest["native/local.pretty/A.kicad_mod"]).toBeString();
    await writeFile(join(root, "native", "local.pretty", "A.kicad_mod"), "second");
    expect((await captureInputs(root, "native/design.kicad_pcb")).manifest).not.toEqual(a.manifest);
    await expect(captureInputs(root, "../escape.kicad_pcb")).rejects.toThrow("escapes");
    const e = await refresh(root, "native/design.kicad_pcb", async () => null);
    expect(e.sourceStatus).toBe("failed");
    expect(packet(e).check.counts).toBeNull();
    expect((await inspect(root, e.board, e.revision)).historical).toBe(true);
    const namespace = (await readdir(join(root, ".fabdesk", "representation")))[0]!;
    const evidencePath = join(
      root,
      ".fabdesk",
      "representation",
      namespace,
      e.revision,
      "evidence.json",
    );
    const damaged = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
    damaged["failure"] = "corrupt history";
    await writeFile(evidencePath, JSON.stringify(damaged));
    await expect(inspect(root, e.board, e.revision)).rejects.toThrow("evidence hash mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const fixtures = process.env.FABDESK_REPRESENTATION_FIXTURES,
  cli = process.env.FABDESK_REPRESENTATION_KICAD;
const nativeTest = fixtures && cli ? test : test.skip;
for (const name of ["usb", "hdmi"])
  nativeTest(
    `native ${name}: saved facts, outside edits, history, invalid capture and recovery`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "representation-native-"));
      try {
        await cp(join(fixtures!, name), join(root, "nested"), { recursive: true });
        const board = "nested/board.kicad_pcb",
          resolve = (o: { env: NodeJS.ProcessEnv; cwd: string }) => findKicadCli(cli!, o);
        const bytes = await readFile(join(root, board));
        const oracle = async (facts: Awaited<ReturnType<typeof refresh>>) => {
          const python = process.env.FABDESK_REPRESENTATION_ORACLE;
          if (!python) return;
          const proc = Bun.spawn(
            [
              python,
              "-c",
              "import pcbnew,json,sys; b=pcbnew.LoadBoard(sys.argv[1]); print(json.dumps({p.m_Uuid.AsString():[int(p.GetPosition().x),int(p.GetPosition().y)] for f in b.GetFootprints() for p in f.Pads()}))",
              join(root, board),
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          const truth = JSON.parse(await new Response(proc.stdout).text()) as Record<
            string,
            number[]
          >;
          expect(await proc.exited).toBe(0);
          const represented = Object.fromEntries(
            facts.facts
              .filter((f) => f.type === "KOT_PCB_PAD")
              .map((f) => {
                const n = f.native as { position?: { xNm?: string; yNm?: string } };
                return [f.id, [Number(n.position?.xNm ?? 0), Number(n.position?.yNm ?? 0)]];
              }),
          );
          expect(represented).toEqual(truth);
        };
        const a = await refresh(root, board, resolve);
        await oracle(a);
        const checkRoot = join(root, "independent-check");
        await mkdir(checkRoot);
        const env: NodeJS.ProcessEnv = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("KICAD")),
        );
        env.KICAD_CONFIG_HOME = join(checkRoot, "config");
        env.XDG_CONFIG_HOME = join(checkRoot, "xdg");
        await mkdir(env.KICAD_CONFIG_HOME);
        await mkdir(env.XDG_CONFIG_HOME);
        const processCheck = Bun.spawn(
          [
            cli!,
            "pcb",
            "drc",
            "--format",
            "json",
            "--units",
            "mm",
            "--severity-all",
            "--output",
            join(checkRoot, "receipt.json"),
            join(root, board),
          ],
          { env, cwd: checkRoot, stdout: "ignore", stderr: "pipe" },
        );
        expect(await processCheck.exited).toBe(0);
        const independent = JSON.parse(
          await readFile(join(checkRoot, "receipt.json"), "utf8"),
        ) as Record<string, unknown[]>;
        const canonical = (v: unknown): unknown =>
          Array.isArray(v)
            ? v.map(canonical)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, x]) => [k, canonical(x)]),
                )
              : v;
        const occurrences = (values: unknown[]) =>
          values.map((v) => JSON.stringify(canonical(v))).sort();
        for (const category of ["violations", "unconnected_items", "schematic_parity"])
          expect(
            occurrences(
              a.check
                .findings!.filter((f) => f.category === category)
                .map(({ handle, category, ...f }) => f),
            ),
          ).toEqual(occurrences(independent[category]!));

        expect(a.failure).toBeUndefined();
        expect(a.sourceStatus).toBe("current");
        expect(a.check.status).toBe("measured");
        expect(a.check.coverage?.included).toContain("error");
        expect(a.facts.some((f) => f.type === "KOT_PCB_PAD")).toBe(true);
        expect(await readFile(join(root, board))).toEqual(bytes);
        const noop = await refresh(root, board, resolve);
        expect(noop.changes?.changed).toEqual([]);
        const text = bytes.toString();
        await writeFile(
          join(root, board),
          text.replace(/\(at ([\d.-]+) ([\d.-]+)/, (_, x, y) => `(at ${Number(x) + 1} ${y}`),
        );
        const b = await refresh(root, board, resolve);
        await oracle(b);
        expect(b.sourceStatus).toBe("current");
        expect(b.changes!.changed.length).toBeGreaterThan(0);
        expect((await inspect(root, board, a.revision)).historical).toBe(true);
        await writeFile(join(root, board), "(broken");
        const c = await refresh(root, board, resolve);
        expect(c.sourceStatus).toBe("failed");
        expect(c.check.status).toBe("failed");
        await writeFile(join(root, board), bytes);
        const d = await refresh(root, board, resolve);
        expect(d.sourceStatus).toBe("current");
        const proPath = join(root, "nested/board.kicad_pro"),
          originalProject = await readFile(proPath, "utf8");
        const alteredProject = JSON.parse(originalProject);
        alteredProject.board.design_settings.rule_severities.silk_overlap = "ignore";
        await writeFile(proPath, JSON.stringify(alteredProject));
        const coverageChange = await refresh(root, board, resolve);
        expect(coverageChange.sourceStatus).toBe("current");
        expect(coverageChange.changes?.checksComparable).toBe(false);
        await writeFile(proPath, originalProject);
        const f = a.check.findings?.[0];
        if (f)
          expect(
            (await inspect(root, board, a.revision, { finding: f.handle })).findings,
          ).toHaveLength(1);
        const unstable = await refresh(root, board, async (o) => {
          await writeFile(join(root, board), bytes.toString() + "\n");
          return resolve(o);
        });
        expect(unstable.sourceStatus).toBe("unsettled");
        await writeFile(join(root, board), bytes);
        const real = await resolve({ env: process.env, cwd: root });
        expect(real).not.toBeNull();
        const wrapper = join(root, "failing-check");
        await writeFile(
          wrapper,
          `#!/bin/sh\nif [ "$1" = "pcb" ]; then echo failed-check >&2; exit 17; fi\nexec '${cli!.replaceAll("'", "'\\''")}' "$@"\n`,
        );
        await chmod(wrapper, 0o755);
        const failedCheck = await refresh(root, board, async () => ({ ...real!, path: wrapper }));
        expect(failedCheck.sourceStatus).toBe("current");
        expect(failedCheck.check.status).toBe("failed");
        expect(packet(failedCheck).check.counts).toBeNull();
        console.log(
          JSON.stringify({
            fixture: name,
            counts: packet(a).counts,
            checks: packet(a).check,
            originalSource: a.manifest,
            packetBytes: JSON.stringify(packet(a)).length,
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120000,
  );
