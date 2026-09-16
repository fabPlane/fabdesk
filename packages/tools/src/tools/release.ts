/** SHARED-005: one revision-bound verification and complete native/fabrication handoff. */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { PROJECT_FILES, ensureDir, exists, writeAtomic, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import { p, requireKicad } from "./common";
import { zipFiles } from "./export";

const CircuitCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("led-current"), name: z.string().default("LED current"), supplyVolts: z.number().positive(), forwardVolts: z.number().nonnegative(), resistanceOhms: z.number().positive(), minMa: z.number().nonnegative(), maxMa: z.number().positive() }),
  z.object({ kind: z.literal("usb-c-cc"), name: z.string().default("USB-C CC pull-downs"), cc1Ohms: z.number().positive(), cc2Ohms: z.number().positive(), expectedOhms: z.number().positive().default(5100), tolerancePercent: z.number().positive().default(10) }),
  z.object({ kind: z.literal("555-astable"), name: z.string().default("555 astable frequency"), r1Ohms: z.number().positive(), r2Ohms: z.number().positive(), capacitanceFarads: z.number().positive(), expectedHz: z.number().positive(), tolerancePercent: z.number().positive().default(10) }),
  z.object({ kind: z.literal("assertion"), name: z.string().min(1), pass: z.boolean(), evidence: z.string().min(1) }),
]);

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function evaluate(check: z.infer<typeof CircuitCheck>) {
  if (check.kind === "assertion") return {
    ...check,
    evidenceLevel: "declared" as const,
    status: "declared" as const,
    claim: check.pass ? "pass" as const : "fail" as const,
  };
  if (check.kind === "led-current") {
    const measuredMa = Math.max(0, check.supplyVolts - check.forwardVolts) / check.resistanceOhms * 1000;
    return { ...check, evidenceLevel: "computed" as const, measured: { currentMa: measuredMa }, status: measuredMa >= check.minMa && measuredMa <= check.maxMa ? "pass" : "fail" };
  }
  if (check.kind === "usb-c-cc") {
    const tolerance = check.expectedOhms * check.tolerancePercent / 100;
    const pass = [check.cc1Ohms, check.cc2Ohms].every((value) => Math.abs(value - check.expectedOhms) <= tolerance);
    return { ...check, evidenceLevel: "computed" as const, measured: { cc1Ohms: check.cc1Ohms, cc2Ohms: check.cc2Ohms }, status: pass ? "pass" : "fail" };
  }
  const measuredHz = 1.44 / ((check.r1Ohms + 2 * check.r2Ohms) * check.capacitanceFarads);
  const pass = Math.abs(measuredHz - check.expectedHz) <= check.expectedHz * check.tolerancePercent / 100;
  return { ...check, evidenceLevel: "computed" as const, measured: { frequencyHz: measuredHz }, status: pass ? "pass" : "fail" };
}

export function isLibraryMismatch(violation: { rule: string; description: string }): boolean {
  const evidence = `${violation.rule} ${violation.description}`;
  return /(?:^|\s|_)lib(?:rary)?(?:_|\s).*mismatch|(?:^|_)mismatch(?:\s|$)|does not match (?:the )?copy in (?:the )?library/i.test(evidence);
}

const DESIGN_RULE_FLOORS = {
  min_hole_clearance: 0.25,
  min_copper_edge_clearance: 0.5,
  min_track_width: 0.2,
} as const;

export function inspectDesignRuleFloors(projectText: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projectText);
  } catch {
    return { status: "unknown" as const, rules: {}, floors: DESIGN_RULE_FLOORS, violations: ["board.kicad_pro is not valid JSON"] };
  }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const board = root["board"] && typeof root["board"] === "object" ? root["board"] as Record<string, unknown> : {};
  const settings = board["design_settings"] && typeof board["design_settings"] === "object" ? board["design_settings"] as Record<string, unknown> : {};
  const source = settings["rules"] && typeof settings["rules"] === "object" ? settings["rules"] as Record<string, unknown> : {};
  const rules = Object.fromEntries(Object.keys(DESIGN_RULE_FLOORS).flatMap((name) => typeof source[name] === "number" ? [[name, source[name]]] : []));
  const violations = Object.entries(DESIGN_RULE_FLOORS).flatMap(([name, floor]) => {
    const value = source[name];
    return typeof value === "number" && value < floor ? [`${name} was relaxed to ${value} mm (release floor ${floor} mm)`] : [];
  });
  return { status: violations.length ? "fail" as const : "pass" as const, rules, floors: DESIGN_RULE_FLOORS, violations };
}

function sexprBlocks(text: string, head: string): string[] {
  const blocks: string[] = [];
  for (let start = 0; start < text.length; start++) {
    if (!text.startsWith(`(${head}`, start)) continue;
    const boundary = text[start + head.length + 1];
    if (boundary && !/[\s")]/.test(boundary)) continue;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "(") depth++;
      else if (character === ")" && --depth === 0) {
        blocks.push(text.slice(start, index + 1));
        start = index;
        break;
      }
    }
  }
  return blocks;
}

export function inspectPcbPresentation(boardText: string) {
  const footprints = sexprBlocks(boardText, "footprint");
  let referenceFields = 0, visibleReferences = 0;
  for (const footprint of footprints) {
    const property = sexprBlocks(footprint, "property").find((block) => /^\(property\s+"Reference"/.test(block));
    const legacy = sexprBlocks(footprint, "fp_text").find((block) => /^\(fp_text\s+reference\b/.test(block));
    const reference = property ?? legacy;
    if (!reference) continue;
    referenceFields++;
    if (!/\(hide(?:\s+yes)?\)/.test(reference)) visibleReferences++;
  }
  const hiddenReferences = referenceFields - visibleReferences;
  const violations = footprints.length >= 5 && visibleReferences < Math.ceil(footprints.length * 0.8)
    ? [`only ${visibleReferences}/${footprints.length} footprint references are visible`]
    : [];
  return {
    status: violations.length ? "fail" as const : "pass" as const,
    counts: { footprints: footprints.length, referenceFields, visibleReferences, hiddenReferences },
    violations,
  };
}

export const release_build = defineTool({
  name: "release_build",
  toolset: "verify",
  title: "Verify and build the complete release",
  description:
    "Run full-severity ERC, parity-enabled DRC, unconnected/library checks, design-rule floor, schematic-presentation, and PCB-reference visibility checks, task-derived circuit checks, schematic/PCB renders, and complete native/document/fabrication export for one exact saved revision. Missing checks, relaxed safety rules, label-dense stub-only schematics, hidden reference fields, or missing outputs fail the release. Returns SHA-256 revisions and a complete output inventory; any later edit makes this evidence stale.",
  inputSchema: {
    circuitChecks: z.array(CircuitCheck).min(1).describe("Task-derived electrical assertions relevant to this board"),
    buildNotes: z.string().min(1).describe("Assembly notes, design calculations, polarity/orientation guidance and constraints"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ circuitChecks, buildNotes }, ctx) => {
    const project = ctx.requireProject();
    const schematic = p(project, PROJECT_FILES.boardSch);
    const board = p(project, PROJECT_FILES.boardPcb);
    const pro = p(project, PROJECT_FILES.boardPro);
    for (const path of [schematic, board, pro]) if (!(await exists(path))) throw new ToolError(`missing native file ${relative(project.dir, path)}`, "precondition");
    const before = { schematic: await hash(schematic), pcb: await hash(board), project: await hash(pro) };
    const cli = await requireKicad(ctx);
    const reportsDir = await ensureDir(p(project, PROJECT_FILES.reports));
    const rendersDir = await ensureDir(p(project, PROJECT_FILES.renders));
    const exportsDir = await ensureDir(p(project, PROJECT_FILES.exports));
    const gerbersDir = await ensureDir(join(exportsDir, "gerbers"));

    ctx.progress(0.08, "ERC");
    const erc = await ctx.services.kicad.runErc(cli, { schematic, outFile: join(reportsDir, "release-erc.json"), severity: "all", signal: ctx.signal });
    ctx.progress(0.16, "DRC and parity");
    const drc = await ctx.services.kicad.runDrc(cli, { board, outFile: join(reportsDir, "release-drc.json"), severity: "all", schematicParity: true, signal: ctx.signal });
    const gate = ctx.services.kicad.gate({ ...drc, schematicParityChecked: true }, erc, project.manifest().allowedDrcWarnings);
    const calculations = circuitChecks.map(evaluate);
    const designRules = inspectDesignRuleFloors(await readFile(pro, "utf8"));
    const pcbPresentation = inspectPcbPresentation(await readFile(board, "utf8"));
    const schematicSnapshot = await ctx.services.design.schematicInspect(project.dir);
    const labelCount = schematicSnapshot.localLabels.length + schematicSnapshot.globalLabels.length;
    const longWireCount = schematicSnapshot.wires.filter((wire) => Math.hypot(wire.end.x - wire.start.x, wire.end.y - wire.start.y) > 5.08).length;
    const presentationViolations = [
      ...(schematicSnapshot.symbols.length >= 5 && labelCount > schematicSnapshot.symbols.length * 1.5
        ? [`${labelCount} labels for ${schematicSnapshot.symbols.length} symbols`]
        : []),
      ...(schematicSnapshot.symbols.length >= 5 && schematicSnapshot.wires.length >= schematicSnapshot.symbols.length && longWireCount === 0
        ? ["all schematic wires are short label stubs; no readable functional-block wiring"]
        : []),
    ];
    const schematicPresentation = {
      status: presentationViolations.length ? "fail" as const : "pass" as const,
      counts: { symbols: schematicSnapshot.symbols.length, wires: schematicSnapshot.wires.length, labels: labelCount, longWires: longWireCount },
      violations: presentationViolations,
    };

    ctx.progress(0.3, "renders");
    const schematicSvgs = await ctx.services.kicad.exportSchematicSvg(cli, { schematic, outDir: join(rendersDir, "schematic"), signal: ctx.signal });
    const pcbSvg = join(rendersDir, "pcb.svg");
    await ctx.services.kicad.exportPcbSvg(cli, { board, output: pcbSvg, signal: ctx.signal });
    const topPng = join(rendersDir, "release-top.png");
    const bottomPng = join(rendersDir, "release-bottom.png");
    await ctx.services.kicad.renderPng(cli, { board, output: topPng, view: "top", quality: "high", signal: ctx.signal });
    await ctx.services.kicad.renderPng(cli, { board, output: bottomPng, view: "bottom", quality: "high", signal: ctx.signal });
    const schematicPdf = join(exportsDir, "schematic.pdf");
    await ctx.services.kicad.exportSchematicPdf(cli, { schematic, output: schematicPdf, signal: ctx.signal });

    ctx.progress(0.55, "fabrication outputs");
    const gerbers = await ctx.services.kicad.exportGerbers(cli, { board, outDir: gerbersDir, signal: ctx.signal });
    const drills = await ctx.services.kicad.exportDrill(cli, { board, outDir: gerbersDir, signal: ctx.signal });
    const positions = join(exportsDir, "positions.csv");
    await ctx.services.kicad.exportPos(cli, { board, output: positions, signal: ctx.signal });
    const bom = join(exportsDir, "bom.csv");
    await ctx.services.kicad.exportBom(cli, { schematic, output: bom, signal: ctx.signal });
    const connectivity = join(exportsDir, "connectivity.net");
    await ctx.services.kicad.exportNetlist(cli, { schematic, output: connectivity, format: "kicadsexpr", signal: ctx.signal });
    const notes = join(exportsDir, "build-notes.md");
    await writeAtomic(notes, `${buildNotes.trim()}\n`);

    const expected = [pro, schematic, board, schematicPdf, pcbSvg, topPng, bottomPng, positions, bom, connectivity, notes];
    const outputPaths = [...expected, ...schematicSvgs.paths, ...gerbers.paths, ...drills.paths];
    const unique = [...new Set(outputPaths)];
    const inventory = await Promise.all(unique.map(async (path) => {
      const metadata = await stat(path).catch(() => null);
      return metadata?.isFile() && metadata.size > 0
        ? { path: relative(project.dir, path), status: "available" as const, bytes: metadata.size, sha256: await hash(path) }
        : { path: relative(project.dir, path), status: "missing" as const };
    }));
    if (!schematicSvgs.paths.length) inventory.push({ path: "renders/schematic/*.svg", status: "missing" as const });
    if (!gerbers.paths.length) inventory.push({ path: "exports/gerbers/*.gbr", status: "missing" as const });
    if (!drills.paths.length) inventory.push({ path: "exports/gerbers/*.drl", status: "missing" as const });
    if (!(await readdir(gerbersDir)).some((name) => /\.gbrjob$/i.test(name))) inventory.push({ path: "exports/gerbers/*.gbrjob", status: "missing" as const });

    const fabricationEntries = inventory.flatMap((entry) => entry.status === "available" && entry.path.startsWith("exports/") && !entry.path.endsWith("fabrication.zip") ? [{ name: entry.path.slice("exports/".length), path: join(project.dir, entry.path) }] : []);
    const fabricationZip = join(exportsDir, "fabrication.zip");
    if (fabricationEntries.length) await zipFiles(fabricationZip, fabricationEntries);
    const zipMetadata = await stat(fabricationZip).catch(() => null);
    inventory.push(zipMetadata?.size ? { path: "exports/fabrication.zip", status: "available" as const, bytes: zipMetadata.size, sha256: await hash(fabricationZip) } : { path: "exports/fabrication.zip", status: "missing" as const });

    const after = { schematic: await hash(schematic), pcb: await hash(board), project: await hash(pro) };
    const stable = JSON.stringify(before) === JSON.stringify(after);
    const missing = inventory.filter((entry) => entry.status === "missing").map((entry) => entry.path);
    const libraryMismatchViolations = [...erc.violations, ...drc.violations].filter(isLibraryMismatch);
    const checks = {
      erc: { evidenceLevel: "measured", status: erc.counts.errors === 0 ? "pass" : "fail", ...erc },
      drc: { evidenceLevel: "measured", status: drc.counts.errors === 0 ? "pass" : "fail", ...drc, schematicParityChecked: true },
      parity: { evidenceLevel: "measured", status: drc.schematicParity.length === 0 ? "pass" : "fail", violations: drc.schematicParity },
      unconnected: { evidenceLevel: "measured", status: drc.counts.unconnected === 0 ? "pass" : "fail", count: drc.counts.unconnected },
      libraryMismatches: { evidenceLevel: "measured", status: libraryMismatchViolations.length ? "fail" : "pass", count: libraryMismatchViolations.length, violations: libraryMismatchViolations },
      designRules: { evidenceLevel: "computed", ...designRules },
      schematicPresentation: { evidenceLevel: "computed", ...schematicPresentation },
      pcbPresentation: { evidenceLevel: "computed", ...pcbPresentation },
      circuit: calculations,
      revisionStable: { evidenceLevel: "measured", status: stable ? "pass" : "fail" },
    };
    const failedCircuitChecks = calculations
      .filter((check) => check.kind === "assertion" ? !check.pass : check.status === "fail")
      .map((check) => check.name);
    const declaredClaims = calculations.flatMap((check) => check.kind === "assertion"
      ? [{ name: check.name, claim: check.claim, evidence: check.evidence }]
      : []);
    const failureReasons = [
      ...gate.reasons,
      ...(libraryMismatchViolations.length && !gate.reasons.some((reason) => /warning/i.test(reason)) ? [`${libraryMismatchViolations.length} library mismatch(es)`] : []),
      ...designRules.violations.map((reason) => `design rule integrity: ${reason}`),
      ...presentationViolations.map((reason) => `schematic presentation: ${reason}`),
      ...pcbPresentation.violations.map((reason) => `PCB presentation: ${reason}`),
      ...failedCircuitChecks.map((name) => `circuit check failed: ${name}`),
      ...missing.map((path) => `missing output: ${path}`),
      ...(!stable ? ["native files changed while the release was being built"] : []),
    ];
    const pass = stable && gate.pass && libraryMismatchViolations.length === 0 && designRules.status === "pass" && schematicPresentation.status === "pass" && pcbPresentation.status === "pass" && failedCircuitChecks.length === 0 && missing.length === 0;
    const result = {
      contract: { name: "fabdesk.native-release", version: "1.1.0" }, capturedAt: new Date().toISOString(),
      runtime: { runtimeId: ctx.services.runtimeId, fabdeskVersion: ctx.services.version, kicadCli: { path: cli.path, version: cli.version } },
      revisions: before, stale: false, pass,
      verification: {
        status: pass ? "pass" : "fail",
        scope: "configured release checks and outputs",
        productCompletenessAssessed: false,
      },
      evidence: {
        levels: ["measured", "computed", "declared", "missing"],
        declaredClaims,
        note: "declared claims are not independent measurements",
      },
      gate, failureReasons, checks, inventory, missing,
    };
    await writeJson(join(reportsDir, "release.json"), result);
    ctx.progress(1, pass ? "release passed" : "release failed");
    const text = [
      `Release ${pass ? "PASS" : "FAIL"} for ${before.schematic.slice(0, 12)}/${before.pcb.slice(0, 12)}: ${inventory.length - missing.length}/${inventory.length} outputs available.`,
      ...(failureReasons.length ? ["Failure reasons:", ...failureReasons.map((reason) => `- ${reason}`)] : []),
      ...(gate.newWarningSignatures.length ? ["Unapproved warning signatures:", ...gate.newWarningSignatures.map((signature) => `- ${signature}`)] : []),
    ].join("\n");
    return { text, json: result, isError: !pass };
  },
});

export const releaseTools = [release_build];
