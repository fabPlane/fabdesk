import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "vite";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");

test("production layout workers survive replacement of the loaded renderer's build assets", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-production-workers-"));
  try {
    // Follow the constructor dependency used by the actual component. A regression to a
    // file-backed import must fail this runtime check, rather than pass a parallel fixture.
    const designer = join(root, "packages/ui/src/board/mechanical/EnclosureDesigner.tsx");
    const ast = ts.createSourceFile(
      designer,
      await readFile(designer, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const dependency = ast.statements.find(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.split("?")[0] === "./enclosure-layout.worker",
    );
    expect(
      dependency?.importClause?.name,
      "EnclosureDesigner must use its bundled worker constructor",
    ).toBeDefined();
    const specifier = (dependency!.moduleSpecifier as ts.StringLiteral).text;
    const [module, query] = specifier.split("?");
    const worker =
      "/" +
      relative(root, resolve(dirname(designer), module!)).replaceAll("\\", "/") +
      (query ? `?${query}` : "");
    const entry = join(scratch, "entry.ts");
    await writeFile(
      entry,
      `
import LayoutWorker from ${JSON.stringify(worker)};
export { placementJob } from "/packages/ui/src/board/placement/placement-jobs.ts";
export { defaultEnclosureDesign } from "/packages/client-core/src/enclosure-design.ts";
export const makeLayoutWorker = () => new LayoutWorker();
// Negative control: reproduce the old hashed-worker URL after a rebuild removes it.
export const makeFileWorker = () => new Worker(new URL("/packages/ui/src/board/mechanical/enclosure-layout.worker.ts", import.meta.url), { type: "module" });
`,
    );
    const output = join(scratch, "dist");
    await build({
      configFile: false,
      root,
      logLevel: "error",
      build: {
        outDir: output,
        emptyOutDir: true,
        sourcemap: false,
        target: "es2022",
        minify: true,
        lib: { entry, formats: ["es"], fileName: () => "entry.mjs" },
      },
    });
    expect((await readdir(output, { recursive: true })).some((path) => path.endsWith(".map"))).toBe(
      false,
    );
    const node = Bun.which("node");
    expect(node, "Node is required for real worker_threads packaging checks").not.toBeNull();
    const process = Bun.spawn(
      [
        node!,
        join(import.meta.dir, "production-worker-runtime.mjs"),
        join(output, "entry.mjs"),
        join(root, "packages/client-core/src/placement/fixtures/usb-timer.kicad_pcb"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(code, stderr || stdout).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result).toEqual({
      enclosureBoards: 2,
      placementParts: 12,
      resized: [40, 30],
      staleFileWorkerRejected: true,
      externalFilesAfterLoad: 0,
    });
  } finally {
    // scratch was created by mkdtemp under the OS temp directory, never a project path.
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
