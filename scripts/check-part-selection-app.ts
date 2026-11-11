/** Native desktop smoke test. Run against a disposable, rendered single-board project.
 * FABDESK_USER_DATA=... FABDESK_TEST_PROJECT_ID=... bun scripts/check-part-selection-app.ts
 * Optional FABDESK_CAPTURE_DIR and FABDESK_BASELINE=1 capture the same steps on main.
 * No agent runs, file edits, model regeneration, or persistent preference changes.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreClient, inspectSelectionIndex } from "../packages/client-core/src";
const profile = process.env.FABDESK_USER_DATA, projectId = process.env.FABDESK_TEST_PROJECT_ID;
if (!profile || !projectId) throw new Error("Use an isolated dev profile and disposable FABDESK_TEST_PROJECT_ID.");
const baseline = process.env.FABDESK_BASELINE === "1", reference = process.env.FABDESK_TEST_REFERENCE ?? "U1";
const config = (name: string) => JSON.parse(readFileSync(join(profile, name), "utf8"));
async function bridge(path: string, body?: unknown): Promise<any> { const { token } = config("daemon.json"), { url } = config("app-bridge.json"); const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data; }
const page = async (code: string) => (await bridge("/eval", { code })).result;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(code: string) { for (let n = 0; n < 120; n++) { if (await page(code)) return; await sleep(250); } throw new Error(`Timed out: ${code}`); }
let passed = 0;
const check = (name: string, condition: boolean) => { if (!condition) throw new Error(`FAIL ${name}`); passed++; console.log(`PASS ${name}`); };
const capture = async (name: string) => { const folder = process.env.FABDESK_CAPTURE_DIR; if (!folder) return; mkdirSync(folder, { recursive: true }); const shot = await bridge("/screenshot", { format: "png", scale: .5 }); writeFileSync(join(folder, `${name}.png`), Buffer.from(shot.base64, "base64")); };
const { port, token } = config("daemon.json"), client = new CoreClient({ baseUrl: `http://127.0.0.1:${port}`, token });
const index = await inspectSelectionIndex(client, projectId);
if (!index.pcb?.parts.some(p => p.ref === reference) || !index.sheets.some(s => s.parts.some(p => p.ref === reference))) throw new Error("Fixture must contain the selected part in its source-verified PCB and schematic previews.");
await bridge("/ui", { action: "selectProject", args: [projectId] });
await page(`window.__selectionErrors=[];window.addEventListener('error',e=>window.__selectionErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__selectionErrors.push(String(e.reason)));`);
const open = async (tab: string) => { await bridge("/ui", { action: "openTab", args: [tab] }); await until(tab === "3d" ? `!!document.querySelector('.fd-model-viewport canvas') && !document.querySelector('.fd-model-message')` : `!!document.querySelector('.fd-svg-host canvas')`); if (!baseline) await until(`!!document.querySelector('.fd-part-selection-bar select option[value=${JSON.stringify(reference)}]')`); await sleep(350); if (tab !== "3d") { await bridge("/click", { selector: '.fd-svg-fit-button[title="Show the whole drawing"]' }); await until(`document.querySelector('.fd-svg-zoom-value')?.textContent==='100%'`); } };
const selected = () => page(`document.querySelector('.fd-part-selection-bar select')?.value`);
const pick = async (view: "pcb" | "schematic", ref: string) => {
  // Schematic viewports persist zoom/pan between mounts. Reset before mapping
  // native drawing coordinates so this check is repeatable after manual focus.
  await bridge("/click", { selector: '.fd-svg-fit-button[title="Show the whole drawing"]' });
  await until(`document.querySelector('.fd-svg-zoom-value')?.textContent==='100%'`);
  const part = (view === "pcb" ? index.pcb!.parts : index.sheets[0]!.parts).find(p => p.ref === ref); if (!part) throw new Error(`Fixture part ${ref} missing`);
  const svgPath = view === "pcb" ? "renders/pcb.svg" : index.sheets[0]!.path, svg = await client.readFile(projectId, svgPath);
  const box = /viewBox="([^"]+)"/.exec(svg)![1]!.split(/\s+/).map(Number), bounds = part.box;
  const rect = await page(`document.querySelector('.fd-svg-host').getBoundingClientRect().toJSON()`);
  await bridge("/click", { x: rect.x + (bounds.x + bounds.width / 2 - box[0]!) / box[2]! * rect.width, y: rect.y + (bounds.y + bounds.height / 2 - box[1]!) / box[3]! * rect.height });
};
await open("pcb");
const zoomBefore = await page(`document.querySelector('.fd-svg-zoom-value')?.textContent`);
await pick("pcb", reference);
if (!baseline) {
  await until(`document.querySelector('.fd-part-selection-bar select')?.value===${JSON.stringify(reference)}`);
  check("PCB click selects the component", await selected() === reference);
  check("Selecting does not zoom the drawing", await page(`document.querySelector('.fd-svg-zoom-value')?.textContent`) === zoomBefore);
  check("PCB highlight is visible", await page(`!!document.querySelector('[data-component-ref=${JSON.stringify(reference)}]')`));
}
await capture("01-pcb");
await open("schematic");
if (!baseline) { check("Selection follows to schematic", await selected() === reference); check("Schematic counterpart is highlighted", await page(`!!document.querySelector('[data-component-ref=${JSON.stringify(reference)}]')`)); }
await capture("02-schematic");
await open("3d");
if (!baseline) { check("Selection follows to 3D", await selected() === reference); await until(`document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===${JSON.stringify(reference)}`); check("Native model geometry is highlighted", true); }
await capture("03-3d");
if (!baseline) {
  const overlap = await page(`(()=>{const bar=document.querySelector('.fd-part-selection-bar').getBoundingClientRect();return [...document.querySelectorAll('.fd-board-model-actions,.fd-board-model-status-floating')].some(e=>{const r=e.getBoundingClientRect();return r.top<bar.bottom&&r.bottom>bar.top&&r.right>bar.left&&r.left<bar.right})})()`);
  check("3D controls do not overlap the selection bar", !overlap);
  await bridge("/click", { selector: '.fd-part-selection-bar select option[value="R2"]' });
  await until(`document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent==='R2'`);
  check("3D component selector updates the highlight", await selected() === "R2");
  await open("schematic"); check("3D selection follows back to schematic", await selected() === "R2");
  await pick("schematic", "R1"); await until(`document.querySelector('.fd-part-selection-bar select')?.value==='R1'`); check("Schematic click changes the shared selection", true);
  await open("pcb"); check("Schematic selection follows back to PCB", await selected() === "R1");
  await page(`document.querySelector('.fd-svg-host').focus()`); await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('[data-component-ref]')`); check("Escape clears the PCB highlight", await selected() === "");
  await open("3d"); check("Escape also clears the 3D selection", await selected() === "");
  await open("schematic"); check("Escape also clears schematic selection", await selected() === "");
  const controls = await page(`Array.from(document.querySelectorAll('.fd-part-selection-bar select,.fd-part-selection-bar button')).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`);
  check("Selection controls stay reachable", controls);
}
check("No uncaught renderer errors", (await page("window.__selectionErrors")).length === 0);
console.log(`All ${passed} passed · ${baseline ? "main baseline" : "feature"} · ${JSON.stringify((await bridge('/state')).ui.page)}`);
