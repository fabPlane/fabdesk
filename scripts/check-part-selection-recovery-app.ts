/** Native source/model refresh regression checks. Only use a disposable project.
 * FABDESK_USER_DATA, FABDESK_TEST_PROJECT_ID and FABDESK_TEST_PROJECT_DIR are required.
 * Temporarily changes source/model receipts and restores exact bytes in finally.
 * No agents, paid runs, model exports, or production endpoints.
 */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const profile = process.env.FABDESK_USER_DATA, projectId = process.env.FABDESK_TEST_PROJECT_ID, directory = process.env.FABDESK_TEST_PROJECT_DIR;
if (!profile || !projectId || !directory) throw new Error("Provide an isolated profile and disposable project ID/directory.");
const root = realpathSync(directory);
if (JSON.parse(readFileSync(join(root, "fabdesk.json"), "utf8")).id !== projectId) throw new Error("Project identity does not match the disposable fixture.");
const config = (name: string) => JSON.parse(readFileSync(join(profile, name), "utf8"));
async function bridge(path: string, body?: unknown): Promise<any> {
  const { token } = config("daemon.json"), { url } = config("app-bridge.json");
  const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
const page = async (code: string) => (await bridge("/eval", { code })).result;
async function until(code: string) { for (let i = 0; i < 120; i++) { if (await page(code)) return; await Bun.sleep(250); } throw new Error(`Timed out: ${code}`); }
async function openPartPicker(ref: string) {
  await bridge("/click", { selector: ".fd-part-picker:not(:disabled)" });
  await until(`!!document.querySelector(\`[cmdk-item][data-value=${JSON.stringify(ref)}]\`)`);
}
async function choosePart(ref: string) {
  await openPartPicker(ref);
  await bridge("/click", { selector: `[cmdk-item][data-value=${JSON.stringify(ref)}]` });
}
let passed = 0;
const check = (name: string, condition: boolean) => { if (!condition) throw new Error(`FAIL ${name}`); passed++; console.log(`PASS ${name}`); };
const selected = (ref: string) => `document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===${JSON.stringify(ref)}`;
const bounds = () => page(`JSON.parse(document.querySelector('.fd-model-viewport canvas').dataset.componentBounds)`);
const inside = (b: any) => b.left >= -1 && b.right <= 1 && b.top <= 1 && b.bottom >= -1;
const near = (a: any, b: any) => ["left", "right", "top", "bottom"].every(key => Math.abs(a[key] - b[key]) < 1e-6);
const sourcePath = join(root, "board.kicad_pcb"), modelPath = join(root, "renders/board.glb"), receiptPath = modelPath + ".revision.json";
const source = readFileSync(sourcePath), model = readFileSync(modelPath), receipt = readFileSync(receiptPath);
const pcbPath = join(root, "renders/pcb.svg"), pcbReceiptPath = pcbPath + ".revision.json";
const pcb = readFileSync(pcbPath), pcbReceipt = readFileSync(pcbReceiptPath);
const originalSize = await page(`({width:innerWidth,height:innerHeight})`);
if ((await bridge("/ui", { action:"selectProject", args:[projectId] })).result.activeProjectId !== projectId) throw new Error("Open the disposable project before running these checks.");
await bridge("/ui", { action:"openTab", args:["pcb"] });
if (!await page(`!!document.querySelector('.fd-shared-part-selection')`)) await bridge("/click", { selector:'button[aria-label="Compare views"]' });
await until(`!!document.querySelector('.fd-shared-part-selection .fd-part-picker') && !document.querySelector('.fd-shared-part-selection .fd-part-picker').disabled && !!document.querySelector('.fd-model-viewport canvas')`);
await page(`(()=>{window.__recoveryErrors=[];window.addEventListener('error',e=>window.__recoveryErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__recoveryErrors.push(String(e.reason)));})()`);
try {
  await page(`window.resizeTo(1440,920)`); await Bun.sleep(300);
  await choosePart("U1");
  await until(selected("U1")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
  await bridge("/click", { selector:'.fd-comparison-pane[data-view="pcb"] .fd-svg-fit-button[title="Show the whole drawing"]' });
  const point = await page(`(()=>{const r=document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-component-ref="U1"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  // Hold only the replacement image's load event. The old bitmap stays visible,
  // exercising the gap between verified source metadata and actual painting.
  await page(`(()=>{window.__holdPreview=e=>{if(e.target.matches?.('.fd-comparison-pane[data-view="pcb"] .fd-svg-host > img')){e.stopImmediatePropagation();window.__heldPreview=e.target}};document.addEventListener('load',window.__holdPreview,true)})()`);
  const refreshedPcb = Buffer.from(pcb.toString().replace('</svg>', '<!-- refreshed preview audit -->\n</svg>'));
  const refreshedReceipt = JSON.parse(pcbReceipt.toString()); refreshedReceipt.artifactSha256 = createHash("sha256").update(refreshedPcb).digest("hex");
  writeFileSync(pcbPath, refreshedPcb); writeFileSync(pcbReceiptPath, JSON.stringify(refreshedReceipt));
  await until(`!!window.__heldPreview && !document.querySelector('.fd-shared-part-selection .fd-part-picker').disabled`);
  check("An unpainted replacement preview hides source-bound overlays", await page(`!!document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-host[aria-busy="true"]') && !document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-component-ref]')`));
  await bridge("/click", { selector:'.fd-shared-part-selection button[aria-label="Clear selection"]' }); await bridge("/click", point);
  await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-host').focus()`); await bridge("/key", { key:"Enter" });
  check("Unpainted previews reject mouse and keyboard selection", await page(`document.querySelector('.fd-shared-part-selection .fd-part-picker').value==='' && !document.querySelector('.fd-location-toolbar')`));
  await page(`(()=>{document.removeEventListener('load',window.__holdPreview,true);window.__heldPreview.dispatchEvent(new Event('load'));delete window.__holdPreview;delete window.__heldPreview})()`);
  await until(`!!document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-host[aria-busy="false"]')`);
  await bridge("/click", point); await until(selected("U1"));
  check("Selection resumes only after the verified replacement is painted", await page(`!!document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-component-ref="U1"]')`));
  writeFileSync(sourcePath, Buffer.concat([source, Buffer.from("\n")]));
  await until(selected(""));
  check("Stale PCB source removes PCB and 3D highlights", await page(`!document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-component-ref]') && document.querySelector('.fd-model-viewport canvas').dataset.tintedMeshes==='0'`));
  writeFileSync(sourcePath, source);
  await until(selected("U1"));
  check("Restoring exact source recovers the selected part", await page(`!!document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-component-ref="U1"]')`));
  await page(`window.resizeTo(960,600)`); await Bun.sleep(400);
  check("Source revalidation preserves 3D framing through resize", inside(await bounds()));
  await page(`window.resizeTo(1440,920)`); await Bun.sleep(400);
  await choosePart("R2");
  await until(selected("R2")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
  const focused = await bounds();
  await page(`window.__recoveryCanvas=document.querySelector('.fd-model-viewport canvas')`);
  const jsonLength = model.readUInt32LE(12), asset = JSON.parse(model.subarray(20, 20 + jsonLength).toString()).asset;
  const offset = model.indexOf(Buffer.from(asset.generator), 20), changed = Buffer.from(model);
  if (offset < 20 || offset >= 20 + jsonLength) throw new Error("Fixture needs a GLB asset generator field.");
  changed[offset] = changed[offset] === 65 ? 66 : 65; // Metadata only; exact geometry and chunk sizes remain intact.
  writeFileSync(modelPath, changed);
  await until(`document.querySelector('.fd-model-viewport canvas')!==window.__recoveryCanvas && document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===''`);
  check("Replacement model stays unselected until its receipt matches", true);
  const updatedReceipt = JSON.parse(receipt.toString()); updatedReceipt.artifactSha256 = createHash("sha256").update(changed).digest("hex");
  writeFileSync(receiptPath, JSON.stringify(updatedReceipt));
  await until(selected("R2")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("Verified replacement model retains the small-part close-up", near(focused, await bounds()));
  await bridge("/click", { selector:'.fd-model-view-tools button[aria-label="Zoom in"]' });
  const manual = await bounds();
  writeFileSync(sourcePath, Buffer.concat([source, Buffer.from("\n")])); await until(selected(""));
  writeFileSync(sourcePath, source); await until(selected("R2"));
  check("Source recovery respects manual 3D zoom", near(manual, await bounds()));
  // Keep valid geometry/receipts but remove U1's exporter identity. The UI must
  // report a missing counterpart rather than color some unrelated mesh.
  const json = changed.subarray(20, 20 + jsonLength).toString();
  const unnamedJson = json.replace(/("name"\s*:\s*)"U1"/g, '$1"?1"');
  if (json === unnamedJson || Buffer.byteLength(json) !== Buffer.byteLength(unnamedJson)) throw new Error("Fixture needs an exact U1 exporter node.");
  const missingPartModel = Buffer.from(changed); missingPartModel.write(unnamedJson, 20, jsonLength);
  updatedReceipt.artifactSha256 = createHash("sha256").update(missingPartModel).digest("hex");
  await page(`window.__recoveryCanvas=document.querySelector('.fd-model-viewport canvas')`);
  writeFileSync(modelPath, missingPartModel); writeFileSync(receiptPath, JSON.stringify(updatedReceipt));
  await until(`document.querySelector('.fd-model-viewport canvas')!==window.__recoveryCanvas && (${selected("R2")}) && !document.querySelector('.fd-shared-part-selection .fd-part-picker').disabled`);
  await choosePart("U1");
  await until(`document.querySelector('.fd-comparison-pane[data-view="3d"] [role=status]')?.textContent.includes('U1 has no selectable model')`);
  check("Missing 3D counterpart keeps both verified drawing highlights", await page(`document.querySelectorAll('.fd-comparison-pane [data-component-ref="U1"]').length===2`));
  check("Missing counterpart disables Focus and removes the previous model tint", await page(`document.querySelector('button[aria-label="Focus selected in 3D"]').disabled && document.querySelector('.fd-model-viewport canvas').dataset.tintedMeshes==='0'`));
  await choosePart("R2"); await until(selected("R2"));
} finally {
  await page(`(()=>{if(window.__holdPreview)document.removeEventListener('load',window.__holdPreview,true);window.__heldPreview?.dispatchEvent(new Event('load'));delete window.__holdPreview;delete window.__heldPreview})()`);
  writeFileSync(sourcePath, source); writeFileSync(modelPath, model); writeFileSync(receiptPath, receipt);
  writeFileSync(pcbPath, pcb); writeFileSync(pcbReceiptPath, pcbReceipt);
  await page(`window.resizeTo(${originalSize.width},${originalSize.height})`);
}
await until(selected("R2")); await until(`!document.querySelector('.fd-model-message')`);
check("All disposable source/model/receipt bytes are restored", readFileSync(sourcePath).equals(source) && readFileSync(modelPath).equals(model) && readFileSync(receiptPath).equals(receipt) && readFileSync(pcbPath).equals(pcb) && readFileSync(pcbReceiptPath).equals(pcbReceipt));
check("Recovery produces no uncaught renderer errors", (await page(`window.__recoveryErrors`)).length === 0);
console.log(`All ${passed} recovery checks passed.`);
