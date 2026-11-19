import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedStockModel, downloadStockModel, officialStockModel, stockModelCacheRoot, stockModelUrl, type ModelFetch } from "../src/stock-model-cache";
import { prepareBoardModels } from "../src/prepare-models";
import { resolveModelPath } from "../src/mechanical";
import { rewriteModelPaths, withModelBoard } from "../src/model-board";

const declaration = "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/FabDesk_Test_Part_0603.step";
const step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
const directories: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "fabdesk-model-cache-test-")); directories.push(root); return root; }
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
const response: ModelFetch = async () => new Response(step);

test("only exact official references are eligible; WRL selects the native same-stem STEP", () => {
  const source = officialStockModel(declaration)!;
  expect(stockModelUrl(source)).toBe("https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/d5db5cea003fe2b4b1c9b145f5fcbd5fdb48f8ca/Resistor_SMD.3dshapes/FabDesk_Test_Part_0603.step");
  expect(officialStockModel(declaration.replace(".step", ".wrl"))).toEqual(source);
  for (const path of ["https://example.com/model.step", "${KIPRJMOD}/model.step", "../model.step", "C:/models/part.step", declaration.replace("KICAD9", "KICAD999"), declaration.replace("FabDesk_Test_Part_0603", "../../escape"), declaration.replace("FabDesk_Test_Part_0603", "%2fescape")]) expect(officialStockModel(path)).toBeNull();
});

test("offline cache reuse and content deduplication across project/version references", async () => {
  const root = await fixture(); let requests = 0;
  const request: ModelFetch = async () => { requests++; return new Response(step); };
  const first = await downloadStockModel(declaration, { root, fetch: request });
  expect(await downloadStockModel(declaration, { root, fetch: async () => { throw Error("offline"); } })).toBe(first);
  expect(await downloadStockModel(declaration.replace("KICAD9", "KICAD8"), { root, fetch: request })).toBe(first);
  expect(requests).toBe(2);
  expect((await readdir(join(root, "objects"))).filter(name => name.endsWith(".step"))).toHaveLength(1);
  expect(await readFile(first!, "utf8")).toBe(step);
});

test("concurrent callers share one request and cancellation does not cancel another viewer", async () => {
  const root = await fixture(), abort = new AbortController(); let requests = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const request: ModelFetch = async (_url, options) => { requests++; await gate; options.signal.throwIfAborted(); return new Response(step); };
  const first = downloadStockModel(declaration, { root, fetch: request, signal: abort.signal });
  const cancelled = first.catch(() => "cancelled");
  const second = downloadStockModel(declaration, { root, fetch: request });
  abort.abort(); finish();
  expect(await cancelled).toBe("cancelled");
  expect(await second).not.toBeNull(); expect(requests).toBe(1);
});

test("an interrupted sole download never publishes a usable cache entry", async () => {
  const root = await fixture(), abort = new AbortController();
  const request: ModelFetch = async (_url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  const pending = downloadStockModel(declaration, { root, signal: abort.signal, fetch: request });
  const result = pending.catch(() => "cancelled"); abort.abort();
  expect(await result).toBe("cancelled"); expect(cachedStockModel(declaration, root)).toBeNull();
  expect(await downloadStockModel(declaration, { root, fetch: response })).not.toBeNull();
});

test("corrupt objects are rejected and repaired before reuse", async () => {
  const root = await fixture(), path = (await downloadStockModel(declaration, { root, fetch: response }))!;
  await writeFile(path, "corrupt");
  expect(cachedStockModel(declaration, root)).toBeNull();
  expect(await downloadStockModel(declaration, { root, fetch: response })).toBe(path);
  expect(await readFile(path, "utf8")).toBe(step);
});

test("404 stays missing without a guessed connector, while network errors are retryable", async () => {
  const root = await fixture();
  expect(await downloadStockModel(declaration, { root, fetch: async () => new Response(null, { status: 404 }) })).toBeNull();
  expect(cachedStockModel(declaration, root)).toBeNull();
  await expect(downloadStockModel(declaration, { root, fetch: async () => new Response(null, { status: 503 }) })).rejects.toThrow("Retry when online");
  expect(await downloadStockModel(declaration, { root, fetch: response })).not.toBeNull();
});

test("rejects HTML, incomplete STEP, oversized responses, and tampered cache receipts", async () => {
  const root = await fixture();
  for (const body of ["<html>Sign in</html>", "ISO-10303-21;\ntruncated"]) await expect(downloadStockModel(declaration, { root, fetch: async () => new Response(body) })).rejects.toThrow("complete STEP");
  await expect(downloadStockModel(declaration, { root, fetch: async () => new Response(step, { headers: { "content-length": String(51 * 1024 * 1024) } }) })).rejects.toThrow("50 MB");
  await downloadStockModel(declaration, { root, fetch: response });
  const receipt = join(root, "refs", (await readdir(join(root, "refs")))[0]!);
  await writeFile(receipt, JSON.stringify({ commit: officialStockModel(declaration)!.commit, path: officialStockModel(declaration)!.path, sha256: "../../escape", bytes: step.length }));
  expect(cachedStockModel(declaration, root)).toBeNull();
});

test("existing installed and custom models win without network or source edits", async () => {
  const root = await fixture(), library = join(root, "library"), board = join(root, "board.kicad_pcb");
  await mkdir(join(library, "Resistor_SMD.3dshapes"), { recursive: true });
  await writeFile(join(library, "Resistor_SMD.3dshapes/FabDesk_Test_Part_0603.step"), step);
  await writeFile(join(root, "custom.step"), step);
  const source = `(kicad_pcb (footprint "R" (property "Reference" "R1") (model "${declaration}" (offset (xyz 1 2 3)))) (footprint "USB" (property "Reference" "J1") (model "\${KIPRJMOD}/custom.step" (offset (xyz 0 -5.33 4.25)))))`;
  await writeFile(board, source);
  const result = await prepareBoardModels({ path: "unused", version: "10" }, { board, env: { FABDESK_HOME: root, KICAD9_3DMODEL_DIR: library }, fetch: async () => { throw Error("must not fetch"); } });
  expect(result.warnings).toEqual([]); expect(await readFile(board, "utf8")).toBe(source);
});

test("missing exact stock files download once, become resolvable, and stay separate from custom missing models", async () => {
  const root = await fixture(), board = join(root, "board.kicad_pcb"), env = { FABDESK_HOME: root, KICAD9_3DMODEL_DIR: join(root, "absent") }; let requests = 0;
  await writeFile(board, `(kicad_pcb (footprint "R" (property "Reference" "R1") (model "${declaration}")) (footprint "R" (property "Reference" "R2") (model "${declaration}")) (footprint "USB" (property "Reference" "J1") (model "\${KIPRJMOD}/custom.step")))`);
  const result = await prepareBoardModels({ path: "unused", version: "10" }, { board, env, fetch: async () => { requests++; return new Response(step); } });
  expect(requests).toBe(1); expect(result.warnings).toHaveLength(1); expect(result.warnings[0]).toContain("J1");
  expect(resolveModelPath(declaration, root, env)).toMatchObject({ status: "resolved", path: cachedStockModel(declaration, stockModelCacheRoot(env)) });
});

test("export copy changes only real model paths, preserving offsets, labels and project settings", async () => {
  const root = await fixture(), board = join(root, "board.kicad_pcb");
  const source = `(kicad_pcb (gr_text "fake (model \\\"stock.step\\\")") (footprint "USB" (model "stock.step" (offset (xyz 0 -5.33 4.25)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))))`;
  await writeFile(board, source); await writeFile(join(root, "board.kicad_pro"), '{"text_variables":{"custom":"keep"}}');
  const expected = source.replace('(model "stock.step"', '(model "C:/cache/model.step"');
  expect(rewriteModelPaths(source, () => "C:/cache/model.step")).toBe(expected);
  let temporary = "";
  await withModelBoard(board, () => "C:/cache/model.step", async path => {
    temporary = path; expect(path).not.toBe(board); expect(await readFile(path, "utf8")).toBe(expected);
    expect(await readFile(path.replace(".kicad_pcb", ".kicad_pro"), "utf8")).toContain('"custom":"keep"');
  });
  expect(await Bun.file(temporary).exists()).toBe(false); expect(await readFile(board, "utf8")).toBe(source);
});

test("a varied 1000-component board fetches 300 unique missing models with bounded concurrency and shares them with another project", async () => {
  const root = await fixture(), board = join(root, "large.kicad_pcb"), env = { FABDESK_HOME: root };
  const libraries = ["Connector_USB", "Package_QFN", "RF_Module", "Inductor_SMD", "Package_BGA", "Resistor_SMD"];
  const parts = Array.from({ length: 1000 }, (_, i) => {
    const index = i % 300;
    return `(footprint "${libraries[index % libraries.length]}:test" (property "Reference" "U${i}") (model "\${KICAD10_3DMODEL_DIR}/${libraries[index % libraries.length]}.3dshapes/FabDesk_Complex_Test_${index}.step"))`;
  });
  const source = `(kicad_pcb ${parts.join(" ")})`; await writeFile(board, source);
  let requests = 0, active = 0, peak = 0;
  const request: ModelFetch = async url => {
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(step.replace("HEADER;", `HEADER;\n/* ${url} */`));
  };
  expect((await prepareBoardModels({ path: "unused", version: "10" }, { board, env, fetch: request })).warnings).toEqual([]);
  expect(requests).toBe(300); expect(peak).toBeLessThanOrEqual(3);
  expect((await readdir(join(stockModelCacheRoot(env), "objects"))).filter(name => name.endsWith(".step"))).toHaveLength(300);
  const other = join(root, "other-project.kicad_pcb"); await writeFile(other, source);
  await prepareBoardModels({ path: "unused", version: "10" }, { board: other, env, fetch: async () => { throw Error("Already cached for another project"); } });
  expect(await readFile(board, "utf8")).toBe(source);
});

test("unassigned custom parts are identified, while hidden and DNP models are not downloaded", async () => {
  const root = await fixture(), board = join(root, "board.kicad_pcb");
  await writeFile(board, `(kicad_pcb (footprint "Custom:Connector" (property "Reference" "J1")) (footprint "R" (property "Reference" "R1") (attr dnp) (model "${declaration}")) (footprint "U" (property "Reference" "U1") (model "${declaration}" (hide yes))))`);
  const result = await prepareBoardModels({ path: "unused", version: "10" }, { board, env: { FABDESK_HOME: root }, fetch: async () => { throw Error("Should not download hidden/DNP models"); } });
  expect(result.warnings).toEqual(["J1: no 3D model is assigned; add the exact part model."]);
});

test("copper-only test pads need no model, but physical test-point pins still report missing bodies", async () => {
  const root = await fixture(), board = join(root, "board.kicad_pcb");
  await writeFile(board, `(kicad_pcb (footprint "TestPoint:TestPoint_Pad_D2.0mm" (property "Reference" "TP1")) (footprint "TestPoint:TestPoint_Keystone_5000-5004_Miniature" (property "Reference" "TP2")))`);
  const result = await prepareBoardModels({ path: "unused", version: "10" }, { board, env: { FABDESK_HOME: root }, fetch: async () => { throw Error("No model references to fetch"); } });
  expect(result.warnings).toEqual(["TP2: no 3D model is assigned; add the exact part model."]);
});
