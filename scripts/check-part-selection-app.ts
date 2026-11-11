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
// Comparisons persist in the isolated profile; begin the walkthrough in one view.
if (await page(`!!document.querySelector('button[aria-label="Close all views"]')`)) await bridge("/click", { selector: 'button[aria-label="Close all views"]' });
const selected = () => page(`document.querySelector('.fd-part-selection-bar select')?.value`);
const pick = async (view: "pcb" | "schematic", ref: string, scope = "") => {
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  // Schematic viewports persist zoom/pan between mounts. Reset before mapping
  // native drawing coordinates so this check is repeatable after manual focus.
  await bridge("/click", { selector: scope + '.fd-svg-fit-button[title="Show the whole drawing"]' });
  await until(`document.querySelector(${JSON.stringify(scope + '.fd-svg-zoom-value')})?.textContent==='100%'`);
  const part = (view === "pcb" ? index.pcb!.parts : index.sheets[0]!.parts).find(p => p.ref === ref); if (!part) throw new Error(`Fixture part ${ref} missing`);
  const svgPath = view === "pcb" ? "renders/pcb.svg" : index.sheets[0]!.path, svg = await client.readFile(projectId, svgPath);
  const box = /viewBox="([^"]+)"/.exec(svg)![1]!.split(/\s+/).map(Number), bounds = part.box;
  const rect = await page(`document.querySelector(${JSON.stringify(scope + '.fd-svg-host')}).getBoundingClientRect().toJSON()`);
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
  await bridge("/click", { selector: '.fd-part-selection-bar select option[value="U1"]' });
  await bridge("/click", { selector: 'button[aria-label="Show all three views"]' });
  const allHighlighted = (ref: string) => `document.querySelectorAll('.fd-comparison-pane [data-component-ref="${ref}"]').length===2 && document.querySelector('.fd-comparison-pane[data-view="3d"] canvas')?.dataset.selectedComponent==='${ref}'`;
  await until(allHighlighted("U1"));
  check("All three views highlight U1 simultaneously", true);
  check("Only one shared component selector is shown", await page(`document.querySelectorAll('select[aria-label="Selected component across views"]').length===1`));
  await page(`window.__comparisonModel = document.querySelector('.fd-model-viewport canvas')`);
  for (const view of ["pcb", "schematic", "3d"]) {
    await bridge("/click", { selector: `.fd-comparison-pane[data-view="${view}"] > header button` });
    check(`Focusing ${view} preserves all three highlights`, await page(allHighlighted("U1")));
  }
  check("Changing focus keeps the same live 3D canvas", await page(`window.__comparisonModel===document.querySelector('.fd-model-viewport canvas')`));
  await bridge("/click", { selector: '.fd-shared-part-selection option[value="R2"]' });
  await until(allHighlighted("R2")); check("Shared selector updates all three views", true);
  await pick("schematic", "R1", '.fd-comparison-pane[data-view="schematic"] ');
  await until(allHighlighted("R1")); check("Schematic click updates PCB and 3D immediately", true);
  check("Schematic click animates the other views", await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] [data-focus-motion="running"]')!==null && document.querySelector('.fd-comparison-pane[data-view="3d"] [data-focus-motion="running"]')!==null`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("Schematic click keeps its own zoom steady", await page(`document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent==='100%'`));
  await pick("pcb", "U1", '.fd-comparison-pane[data-view="pcb"] ');
  await until(allHighlighted("U1")); check("PCB click updates schematic and 3D immediately", true);
  check("PCB click animates the other views", await page(`document.querySelector('.fd-comparison-pane[data-view="schematic"] [data-focus-motion="running"]')!==null && document.querySelector('.fd-comparison-pane[data-view="3d"] [data-focus-motion="running"]')!==null`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("PCB click keeps its own zoom steady", await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-zoom-value')?.textContent==='100%'`));
  const controlsInside = `Array.from(document.querySelectorAll('.fd-comparison-pane')).every(p=>{const pane=p.getBoundingClientRect();return [...p.querySelectorAll('header button,.fd-svg-tools button,.fd-model-view-tools button')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=pane.left&&r.right<=pane.right&&r.top>=pane.top&&r.bottom<=pane.bottom})})`;
  const columns = await page(`document.querySelector('.fd-three-view')?.dataset.layout==='columns'`);
  for (const [label, limits] of [["Resize PCB and other views", columns ? [28,36] : [32,60]], ["Resize schematic and 3D views", columns ? [45,55] : [40,60]]] as const) {
    await page(`document.querySelector('[aria-label="${label}"]').focus()`);
    for (const [key, value] of [["Home", limits[0]], ["End", limits[1]]] as const) {
      await bridge("/key", { key }); await until(`document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-valuenow')==='${value}'`); await sleep(200);
      check(`${label}: controls fit at ${key}`, await page(controlsInside));
      check(`${label}: drawings retain visible space at ${key}`, await page(`[...document.querySelectorAll('.fd-comparison-pane .fd-svg-viewport,.fd-comparison-pane .fd-model-viewport')].every(e=>{const r=e.getBoundingClientRect();return r.width>=200&&r.height>=50})`));
      check(`${label}: assistant does not cover controls at ${key}`, await page(`(()=>{const a=document.querySelector('[data-assistant-launcher]')?.getBoundingClientRect();return !a||[...document.querySelectorAll('.fd-comparison-pane .fd-svg-tools,.fd-comparison-pane .fd-model-view-tools')].every(e=>{const r=e.getBoundingClientRect();return r.right<=a.left||r.left>=a.right||r.bottom<=a.top||r.top>=a.bottom})})()`));
    }
    await bridge("/key", { key: "Home" });
    await bridge("/key", { key: label.includes("PCB") || columns ? "ArrowRight" : "ArrowDown" });
  }
  await bridge("/click", { selector: 'button[aria-label="Actions for selected part in Schematic"]' });
  await until(`!!document.querySelector('.fd-location-toolbar')`);
  check("Component actions stay inside their pane", await page(`(()=>{const p=document.querySelector('.fd-comparison-pane[data-view="schematic"]').getBoundingClientRect(), t=document.querySelector('.fd-location-toolbar').getBoundingClientRect();return t.left>=p.left&&t.right<=p.right&&t.top>=p.top&&t.bottom<=p.bottom})()`));
  await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('.fd-location-toolbar')`);
  check("Escape closes actions before clearing shared selection", await page(allHighlighted("U1")));
  await bridge("/click", { selector: '.fd-comparison-pane[data-view="schematic"] .fd-schematic-status summary' });
  check("Source-status menu stays inside its pane", await page(`(()=>{const p=document.querySelector('.fd-comparison-pane[data-view="schematic"]').getBoundingClientRect(), t=document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-workspace-menu[open] .fd-workspace-menu-content')?.getBoundingClientRect();return !!t&&t.left>=p.left&&t.right<=p.right&&t.top>=p.top&&t.bottom<=p.bottom})()`));
  await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('.fd-schematic-status .fd-workspace-menu[open]')`);
  await until(`(()=>{const pane=document.querySelector('.fd-comparison-pane[data-view="schematic"]'), frame=pane.querySelector('.fd-svg-viewport').getBoundingClientRect(), mark=pane.querySelector('[data-component-ref="U1"]').getBoundingClientRect();return mark.left>=frame.left&&mark.right<=frame.right&&mark.top>=frame.top&&mark.bottom<=frame.bottom})()`);
  check("Linked focus remains visible after resizing panes", true);
  await capture("04-all-three-views");
  await bridge("/click", { selector: 'button[aria-label="Focus selected in Schematic"]' });
  await until(`parseInt(document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent)>100`);
  check("Focus zooms the selected schematic part in a compact pane", await page(`parseInt(document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent)>100`));
  await bridge("/click", { selector: 'button[aria-label="Focus selected in PCB"]' });
  await bridge("/click", { selector: 'button[aria-label="Focus selected in 3D"]' });
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  const focusedInside = `['pcb','schematic'].every(view=>{const pane=document.querySelector('.fd-comparison-pane[data-view="'+view+'"]'), frame=pane.querySelector('.fd-svg-viewport').getBoundingClientRect(), mark=pane.querySelector('[data-component-ref="U1"]').getBoundingClientRect();return mark.left>=frame.left&&mark.right<=frame.right&&mark.top>=frame.top&&mark.bottom<=frame.bottom})`;
  await until(focusedInside); check("Focus keeps the selected part inside both drawing viewports", true);
  await capture("05-focused-in-all-views");
  for (const view of ["pcb", "schematic"]) {
    await bridge("/click", { selector: `.fd-comparison-pane[data-view="${view}"] .fd-svg-fit-button[title="Show the whole drawing"]` });
    await until(`!document.querySelector('.fd-comparison-pane[data-view="${view}"] .fd-svg-focus-stage') && document.querySelector('.fd-comparison-pane[data-view="${view}"] .fd-svg-zoom-value')?.textContent==='100%'`);
    check(`Fit ${view} returns from focused selection to the whole drawing`, true);
  }
  const modelRect = await page(`document.querySelector('.fd-model-viewport canvas').getBoundingClientRect().toJSON()`);
  await bridge("/click", { selector: '.fd-shared-part-selection button' });
  await until(`document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===''`);
  await bridge("/click", { x: modelRect.x + modelRect.width / 2, y: modelRect.y + modelRect.height / 2 });
  await until(allHighlighted("U1")); check("3D model click updates both visible drawings", true);
  check("3D click animates both drawings and keeps its camera steady", await page(`document.querySelectorAll('.fd-comparison-pane .fd-svg-host[data-focus-motion="running"]').length===2 && document.querySelector('.fd-model-viewport canvas')?.dataset.focusMotion!=='running'`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  for (const ref of ["R2", "R1", "U1"]) await bridge("/click", { selector: `.fd-shared-part-selection option[value="${ref}"]` });
  await until(allHighlighted("U1"));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("Rapid reselection settles on the latest part in every view", await page(focusedInside));
  await page(`(()=>{window.__originalMatchMedia=window.matchMedia;window.matchMedia=query=>{const media=window.__originalMatchMedia.call(window,query);return query==='(prefers-reduced-motion: reduce)'?new Proxy(media,{get:(target,key)=>key==='matches'?true:typeof target[key]==='function'?target[key].bind(target):target[key]}):media};})()`);
  try {
    await bridge("/click", { selector: '.fd-shared-part-selection option[value="R2"]' });
    await until(allHighlighted("R2"));
    check("Reduced motion focuses without animation", await page(`!document.querySelector('[data-focus-motion="running"]') && [...document.querySelectorAll('.fd-comparison-pane .fd-svg-zoom-value')].every(e=>parseInt(e.textContent)>100)`));
  } finally { await page(`(()=>{window.matchMedia=window.__originalMatchMedia;delete window.__originalMatchMedia;})()`); }
  await bridge("/click", { selector: '.fd-shared-part-selection option[value="U1"]' });
  await until(allHighlighted("U1")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
  await bridge("/click", { selector: 'button[aria-label="Expand 3D"]' });
  await until(`!document.querySelector('.fd-board-comparison') && !!document.querySelector('.fd-model-viewport canvas') && !!document.querySelector('.fd-part-selection-bar option[value="U1"]')`);
  check("Expand 3D preserves selection", await selected() === "U1");
  await bridge("/click", { selector: 'button[aria-label="Show all three views"]' });
  await until(allHighlighted("U1")); check("All views can be reopened from 3D with the shared selection", true);
  await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-host').focus()`); await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('[data-component-ref]') && document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===''`);
  check("Escape clears all three visible highlights", true);
  await bridge("/click", { selector: 'button[aria-label="Close all views"]' });

}
check("No uncaught renderer errors", (await page("window.__selectionErrors")).length === 0);
console.log(`All ${passed} passed · ${baseline ? "main baseline" : "feature"} · ${JSON.stringify((await bridge('/state')).ui.page)}`);
