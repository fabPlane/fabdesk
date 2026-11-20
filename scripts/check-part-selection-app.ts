/** Native desktop smoke test. Run against a disposable, rendered single-board project.
 * FABDESK_USER_DATA=... FABDESK_TEST_PROJECT_ID=... bun scripts/check-part-selection-app.ts
 * Optional FABDESK_CAPTURE_DIR and FABDESK_BASELINE=1 capture the same steps on main.
 * No agent runs, file edits, model regeneration, or persistent preference changes.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreClient, inspectSelectionIndex, hitSelectionPart } from "../packages/client-core/src";
const profile = process.env.FABDESK_USER_DATA, projectId = process.env.FABDESK_TEST_PROJECT_ID;
if (!profile || !projectId) throw new Error("Use an isolated dev profile and disposable FABDESK_TEST_PROJECT_ID.");
const baseline = process.env.FABDESK_BASELINE === "1", reference = process.env.FABDESK_TEST_REFERENCE ?? "U1";
const config = (name: string) => JSON.parse(readFileSync(join(profile, name), "utf8"));
async function bridge(path: string, body?: unknown): Promise<any> { const { token } = config("daemon.json"), { url } = config("app-bridge.json"); const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data; }
const page = async (code: string) => (await bridge("/eval", { code })).result;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Observe motion during the gesture, rather than racing a 320 ms animation with
// a later bridge round trip on a busy physical machine.
const watchMotion = () => page(`(()=>{window.__motionObserver?.disconnect();window.__animatedViews=[];window.__motionObserver=new MutationObserver(records=>{for(const record of records){const e=record.target;if(record.oldValue==='running'||e.dataset.focusMotion==='running'){const view=e.closest('[data-view]')?.dataset.view;if(view&&!window.__animatedViews.includes(view))window.__animatedViews.push(view)}}});window.__motionObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-focus-motion'],attributeOldValue:true});})()`);

async function until(code: string) { for (let n = 0; n < 120; n++) { if (await page(code)) return; await sleep(250); } throw new Error(`Timed out: ${code}`); }
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
const capture = async (name: string) => { const folder = process.env.FABDESK_CAPTURE_DIR; if (!folder) return; mkdirSync(folder, { recursive: true }); const shot = await bridge("/screenshot", { format: "png", scale: .5 }); writeFileSync(join(folder, `${name}.png`), Buffer.from(shot.base64, "base64")); };
const { port, token } = config("daemon.json"), client = new CoreClient({ baseUrl: `http://127.0.0.1:${port}`, token });
const index = await inspectSelectionIndex(client, projectId);
if (!index.pcb?.parts.some(p => p.ref === reference) || !index.sheets.some(s => s.parts.some(p => p.ref === reference))) throw new Error("Fixture must contain the selected part in its source-verified PCB and schematic previews.");
await bridge("/ui", { action: "selectProject", args: [projectId] });
await page(`window.__selectionErrors=[];window.addEventListener('error',e=>window.__selectionErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__selectionErrors.push(String(e.reason)));`);
const open = async (tab: string) => { await bridge("/ui", { action: "openTab", args: [tab] }); await until(tab === "3d" ? `!!document.querySelector('.fd-model-viewport canvas') && !document.querySelector('.fd-model-message')` : `!!document.querySelector('.fd-svg-host canvas')`); if (!baseline) await until(`!!document.querySelector('.fd-part-picker:not(:disabled)')`); await sleep(350); if (tab !== "3d") { await bridge("/click", { selector: '.fd-svg-fit-button[title="Show the whole drawing"]' }); await until(`document.querySelector('.fd-svg-zoom-value')?.textContent==='100%'`); } };
// Comparisons persist in the isolated profile; begin the walkthrough in one view.
if (await page(`!!document.querySelector('button[aria-label="Single view, close comparison"]')`)) await bridge("/click", { selector: 'button[aria-label="Single view, close comparison"]' });
const selected = () => page(`document.querySelector('.fd-part-picker')?.value`);
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
// Exercise the coordinate-bound PCB drawing rather than the assembled 2D model.
await bridge("/ui", { action: "openTab", args: ["pcb"] });
if (await page("!!document.querySelector('.fd-board-preview')")) {
  const toolsMenu = baseline ? ".fd-canvas-tool-menu" : ".fd-board-inspection-tools";
  await bridge("/click", { selector: toolsMenu + " > summary" });
  await page(`[...document.querySelectorAll('${toolsMenu} button')].find(button => button.textContent === 'PCB drawing & comments').click()`);
}
await open("pcb");
const zoomBefore = await page(`document.querySelector('.fd-svg-zoom-value')?.textContent`);
await pick("pcb", reference);
if (!baseline) {
  await until(`document.querySelector('.fd-part-picker')?.value===${JSON.stringify(reference)}`);
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
  await choosePart("R2");
  await until(`document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent==='R2'`);
  check("3D component selector updates the highlight", await selected() === "R2");
  await open("schematic"); check("3D selection follows back to schematic", await selected() === "R2");
  await pick("schematic", "R1"); await until(`document.querySelector('.fd-part-picker')?.value==='R1'`); check("Schematic click changes the shared selection", true);
  await open("pcb"); check("Schematic selection follows back to PCB", await selected() === "R1");
  await page(`document.querySelector('.fd-svg-host').focus()`); await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('[data-component-ref]')`); check("Escape clears the PCB highlight", await selected() === "");
  await open("3d"); check("Escape also clears the 3D selection", await selected() === "");
  await open("schematic"); check("Escape also clears schematic selection", await selected() === "");
  const controls = await page(`Array.from(document.querySelectorAll('.fd-part-selection-bar button')).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`);
  check("Selection controls stay reachable", controls);
  await choosePart("U1");
  await bridge("/click", { selector: 'button[aria-label="Compare views"]' });
  const allHighlighted = (ref: string) => `document.querySelectorAll('.fd-comparison-pane [data-component-ref="${ref}"]').length===2 && document.querySelector('.fd-comparison-pane[data-view="3d"] canvas')?.dataset.selectedComponent==='${ref}'`;
  await until(allHighlighted("U1"));
  check("All three views highlight U1 simultaneously", true);
  check("Color fill replaces box outlines in both drawings and the 3D mesh", await page(`document.querySelectorAll('.fd-part-selection-highlight polygon').length===2 && [...document.querySelectorAll('.fd-part-selection-highlight')].every(e=>getComputedStyle(e).borderTopWidth==='0px') && Number(document.querySelector('.fd-model-viewport canvas')?.dataset.tintedMeshes)>0`));
  const modelInside = `(()=>{const raw=document.querySelector('.fd-model-viewport canvas')?.dataset.componentBounds;if(!raw)return false;const b=JSON.parse(raw);return b.left>=-1&&b.right<=1&&b.top<=1&&b.bottom>=-1})()`;
  check("Only one shared component selector is shown", await page(`document.querySelectorAll('.fd-part-picker').length===1`));
  await page(`window.__comparisonModel = document.querySelector('.fd-model-viewport canvas')`);
  for (const view of ["pcb", "schematic", "3d"]) {
    await bridge("/click", { selector: `.fd-comparison-pane[data-view="${view}"] > header button` });
    check(`Focusing ${view} preserves all three highlights`, await page(allHighlighted("U1")));
  }
  check("Changing focus keeps the same live 3D canvas", await page(`window.__comparisonModel===document.querySelector('.fd-model-viewport canvas')`));
  await choosePart("R2");
  await until(allHighlighted("R2")); check("Shared selector updates all three views", true);
  await watchMotion();
  await pick("schematic", "R1", '.fd-comparison-pane[data-view="schematic"] ');
  await until(allHighlighted("R1")); check("Schematic click updates PCB and 3D immediately", true);
  check("Schematic click animates the other views", await page(`['pcb','3d'].every(view=>window.__animatedViews.includes(view))`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("Schematic click keeps its own zoom steady", await page(`document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent==='100%'`));
  await watchMotion();
  await pick("pcb", "U1", '.fd-comparison-pane[data-view="pcb"] ');
  await until(allHighlighted("U1")); check("PCB click updates schematic and 3D immediately", true);
  check("PCB click animates the other views", await page(`['schematic','3d'].every(view=>window.__animatedViews.includes(view))`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("PCB click keeps its own zoom steady", await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-zoom-value')?.textContent==='100%'`));
  const controlsInside = `Array.from(document.querySelectorAll('.fd-comparison-pane')).every(p=>{const pane=p.getBoundingClientRect();return [...p.querySelectorAll('header button,header summary,.fd-svg-tools button,.fd-model-view-tools button')].filter(e=>e.checkVisibility()).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=pane.left&&r.right<=pane.right&&r.top>=pane.top&&r.bottom<=pane.bottom})})`;
  const columns = await page(`document.querySelector('.fd-three-view')?.dataset.layout==='columns'`);
  for (const [label, limits] of [["Resize PCB and other views", columns ? [28,36] : [32,60]], ["Resize schematic and 3D views", columns ? [45,55] : [40,60]]] as const) {
    await page(`document.querySelector('[aria-label="${label}"]').focus()`);
    for (const [key, value] of [["Home", limits[0]], ["End", limits[1]]] as const) {
      await bridge("/key", { key }); await until(`document.querySelector('[aria-label="${label}"]')?.getAttribute('aria-valuenow')==='${value}'`); await sleep(200);
      await until(modelInside); check(`${label}: selected 3D component stays framed at ${key}`, true);
      check(`${label}: controls fit at ${key}`, await page(controlsInside));
      check(`${label}: drawings retain visible space at ${key}`, await page(`[...document.querySelectorAll('.fd-comparison-pane .fd-svg-viewport,.fd-comparison-pane .fd-model-viewport')].every(e=>{const r=e.getBoundingClientRect();return r.width>=200&&r.height>=50})`));
      check(`${label}: assistant does not cover controls at ${key}`, await page(`(()=>{const a=document.querySelector('[data-assistant-launcher]')?.getBoundingClientRect();return !a||[...document.querySelectorAll('.fd-comparison-pane .fd-svg-tools,.fd-comparison-pane .fd-model-view-tools')].every(e=>{const r=e.getBoundingClientRect();return r.right<=a.left||r.left>=a.right||r.bottom<=a.top||r.top>=a.bottom})})()`));
    }
    await bridge("/key", { key: "Home" });
    await bridge("/key", { key: label.includes("PCB") || columns ? "ArrowRight" : "ArrowDown" });
  }
  await bridge("/click", { selector: 'summary[aria-label="Part options in Schematic"]' });
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
  await bridge("/click", { selector: 'summary[aria-label="Part options in Schematic"]' });
  await bridge("/click", { selector: 'button[aria-label="Focus selected in Schematic"]' });
  await until(`parseInt(document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent)>100`);
  check("Focus zooms the selected schematic part in a compact pane", await page(`parseInt(document.querySelector('.fd-comparison-pane[data-view="schematic"] .fd-svg-zoom-value')?.textContent)>100`));
  await bridge("/click", { selector: 'summary[aria-label="Part options in PCB drawing"]' });
  await bridge("/click", { selector: 'button[aria-label="Focus selected in PCB drawing"]' });
  await bridge("/click", { selector: 'summary[aria-label="Part options in 3D"]' });
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
  await bridge("/click", { selector: '.fd-shared-part-selection button[aria-label="Clear selection"]' });
  await until(`document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===''`);
  await watchMotion();
  await bridge("/click", { x: modelRect.x + modelRect.width / 2, y: modelRect.y + modelRect.height / 2 });
  await until(allHighlighted("U1")); check("3D model click updates both visible drawings", true);
  check("3D click animates both drawings and zooms into the selected model", await page(`['pcb','schematic','3d'].every(view=>window.__animatedViews.includes(view))`));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  const originalSize = await page(`({width:innerWidth,height:innerHeight})`);
  // Interrupt inside the renderer so bridge latency cannot miss a short animation.
  await openPartPicker("R2");
  const keyInterruption = await page(`new Promise((resolve,reject)=>{document.querySelector('[cmdk-item][data-value="R2"]').click();const started=performance.now();const interrupt=()=>{const c=document.querySelector('.fd-model-viewport canvas');if(c.dataset.focusMotion!=='running'){if(performance.now()-started>5000)return reject(new Error('3D focus did not start'));return requestAnimationFrame(interrupt)}c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',code:'ArrowUp',bubbles:true,cancelable:true}));const motion=c.dataset.focusMotion,bounds=c.dataset.componentBounds;setTimeout(()=>resolve({stopped:motion==='idle',stable:bounds===c.dataset.componentBounds}),400)};requestAnimationFrame(interrupt)})`);
  check("Keyboard panning cancels automatic 3D focus immediately", keyInterruption.stopped && keyInterruption.stable);
  await bridge("/click", { selector: 'summary[aria-label="Part options in 3D"]' });
  await bridge("/click", { selector: 'button[aria-label="Focus selected in 3D"]' });
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  check("A small-part keyboard pan repaints immediately", await page(`(()=>{const c=document.querySelector('.fd-model-viewport canvas'),before=c.dataset.componentBounds;c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',code:'ArrowUp',bubbles:true,cancelable:true}));return before!==c.dataset.componentBounds})()`));
  for (const view of ["pcb", "schematic"]) {
    await bridge("/click", { selector: `.fd-comparison-pane[data-view="${view}"] button[aria-label="Zoom out"]` });
  }
  const manualZoom = await page(`[...document.querySelectorAll('.fd-comparison-pane .fd-svg-zoom-value')].map(e=>e.textContent)`);
  const manualModelBounds = await page(`JSON.parse(document.querySelector('.fd-model-viewport canvas').dataset.componentBounds)`);
  await page(originalSize.width === 960 ? `window.resizeTo(1440,920)` : `window.resizeTo(960,600)`); await sleep(250);
  await page(`window.resizeTo(${originalSize.width},${originalSize.height})`); await sleep(350);
  check("Resizing preserves manual zoom in both drawings", JSON.stringify(manualZoom) === JSON.stringify(await page(`[...document.querySelectorAll('.fd-comparison-pane .fd-svg-zoom-value')].map(e=>e.textContent)`)));
  const resizedModelBounds = await page(`JSON.parse(document.querySelector('.fd-model-viewport canvas').dataset.componentBounds)`);
  // Horizontal projection changes with aspect ratio; vertical projection does not.
  check("Resizing does not undo a keyboard-controlled 3D camera", Math.abs(manualModelBounds.top - resizedModelBounds.top) < 1e-6 && Math.abs(manualModelBounds.bottom - resizedModelBounds.bottom) < 1e-6);
  await choosePart("U1");
  await until(focusedInside); await until(modelInside);
  check("A new selection restores linked focus after manual camera control", true);
  await openPartPicker("R2");
  const clearedInMotion = await page(`new Promise((resolve,reject)=>{document.querySelector('[cmdk-item][data-value="R2"]').click();const started=performance.now();const clear=()=>{if(!document.querySelector('[data-focus-motion="running"]')){if(performance.now()-started>5000)return reject(new Error('Linked focus did not start'));return requestAnimationFrame(clear)}document.querySelector('.fd-shared-part-selection button[aria-label="Clear selection"]').click();setTimeout(()=>resolve(!document.querySelector('[data-focus-motion="running"],[data-component-ref]')&&document.querySelector('.fd-model-viewport canvas').dataset.tintedMeshes==='0'),400)};requestAnimationFrame(clear)})`);
  check("Clear during linked animation removes every highlight and stops motion", clearedInMotion);
  for (const view of ["pcb", "schematic"] as const) {
    await choosePart("U1");
    await until(`!document.querySelector('[data-focus-motion="running"]')`);
    await bridge("/click", { selector: `.fd-comparison-pane[data-view="${view}"] .fd-svg-fit-button[title="Show the whole drawing"]` });
    const parts = view === "pcb" ? index.pcb!.parts : index.sheets[0]!.parts;
    const candidates = parts.filter(p => ["U1", "R1"].includes(p.ref) && hitSelectionPart(parts, { x:p.box.x+p.box.width/2, y:p.box.y+p.box.height/2 })?.ref === p.ref);
    const svg = await client.readFile(projectId, view === "pcb" ? "renders/pcb.svg" : index.sheets[0]!.path);
    const box = /viewBox="([^"]+)"/.exec(svg)![1]!.split(/\s+/).map(Number);
    // Pause a real animation at a known intermediate frame so native input is
    // independent of bridge latency. The visible point must survive interruption.
    await openPartPicker("R2");
    const interrupted = await page(`new Promise((resolve,reject)=>{document.querySelector('[cmdk-item][data-value="R2"]').click();const started=performance.now();const freeze=()=>{const pane=document.querySelector('.fd-comparison-pane[data-view="${view}"]'),host=pane.querySelector('.fd-svg-host'),animation=host.getAnimations()[0];if(!animation){if(performance.now()-started>5000)return reject(new Error('Drawing focus did not start'));return requestAnimationFrame(freeze)}animation.pause();const v=pane.querySelector('.fd-svg-viewport').getBoundingClientRect(),box=${JSON.stringify(box)};for(const time of [40,80,120,160,200,240,280,0]){animation.currentTime=time;const r=host.getBoundingClientRect();const point=${JSON.stringify(candidates)}.map(p=>({ref:p.ref,x:r.left+(p.box.x+p.box.width/2-box[0])/box[2]*r.width,y:r.top+(p.box.y+p.box.height/2-box[1])/box[3]*r.height})).find(p=>p.x>v.left+4&&p.x<v.right-4&&p.y>v.top+4&&p.y<v.bottom-4);if(point)return resolve({point,rect:r.toJSON(),time})}reject(new Error('Fixture has no visible counterpart during focus'))};requestAnimationFrame(freeze)})`);
    await bridge("/click", { x: interrupted.point.x, y: interrupted.point.y });
    await until(allHighlighted(interrupted.point.ref));
    check(`Clicking ${view} during focus selects the visible part, not its destination`, !await page(`!!document.querySelector('.fd-location-toolbar')`));
    const after = await page(`document.querySelector('.fd-comparison-pane[data-view="${view}"] .fd-svg-host').getBoundingClientRect().toJSON()`);
    check(`Interrupting ${view} focus preserves the visible drawing position and zoom`, ["left", "top", "width", "height"].every(key => Math.abs(after[key] - interrupted.rect[key]) <= 1));
  }
  for (let i = 0; i < 24; i++) {
    await choosePart(["R2", "R1", "U1"][i%3]!);
    if (i%6===5) await page(i%12===5 ? `window.resizeTo(960,600)` : `window.resizeTo(1440,920)`);
  }
  await page(`window.resizeTo(${originalSize.width},${originalSize.height})`);
  await until(`innerWidth===${originalSize.width} && innerHeight===${originalSize.height}`);
  await until(allHighlighted("U1"));
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  await until(focusedInside); await until(modelInside);
  check("24 rapid part switches with window resizing settle on the latest part in every view", await page(focusedInside));
  check("Rapid switches retain exactly two colored drawing markers and a tinted 3D model", await page(`document.querySelectorAll('[data-component-ref="U1"]').length===2 && document.querySelectorAll('[data-component-ref]:not([data-component-ref="U1"])').length===0 && Number(document.querySelector('.fd-model-viewport canvas')?.dataset.tintedMeshes)>0`));
  await page(`(()=>{window.__originalMatchMedia=window.matchMedia;window.matchMedia=query=>{const media=window.__originalMatchMedia.call(window,query);return query==='(prefers-reduced-motion: reduce)'?new Proxy(media,{get:(target,key)=>key==='matches'?true:typeof target[key]==='function'?target[key].bind(target):target[key]}):media};})()`);
  try {
    await choosePart("R2");
    await until(allHighlighted("R2"));
    check("Reduced motion focuses without animation", await page(`!document.querySelector('[data-focus-motion="running"]') && [...document.querySelectorAll('.fd-comparison-pane .fd-svg-zoom-value')].every(e=>parseInt(e.textContent)>100)`));
  } finally { await page(`(()=>{window.matchMedia=window.__originalMatchMedia;delete window.__originalMatchMedia;})()`); }
  await choosePart("U1");
  await until(`!document.querySelector('[data-focus-motion="running"]')`);
  await openPartPicker("R2");
  const visibleZoom = await page(`new Promise((resolve,reject)=>{document.querySelector('[cmdk-item][data-value="R2"]').click();const start=performance.now();const freeze=()=>{const pane=document.querySelector('.fd-comparison-pane[data-view="schematic"]'),host=pane.querySelector('.fd-svg-host'),animation=host.getAnimations()[0];if(!animation){if(performance.now()-start>5000)return reject(new Error('Schematic focus did not start'));return requestAnimationFrame(freeze)}animation.pause();animation.currentTime=160;resolve(parseInt(pane.querySelector('.fd-svg-zoom-value').textContent)*host.getBoundingClientRect().width/parseFloat(host.style.width))};requestAnimationFrame(freeze)})`);
  await bridge("/click", { selector:'button[aria-label="Expand Schematic"]' });
  await until(`!document.querySelector('.fd-board-comparison') && !!document.querySelector('[data-component-ref="R2"]')`);
  await until(`Math.abs(parseInt(document.querySelector('.fd-svg-zoom-value').textContent)-${visibleZoom})<=1`);
  check("Expanding during animation preserves the visible zoom rather than jumping to its destination", true);
  await bridge("/click", { selector:'button[aria-label="Compare views"]' }); await until(allHighlighted("R2"));
  for (const [view, label] of [["pcb", "PCB drawing"], ["schematic", "Schematic"]] as const) {
    await choosePart("R2");
    await until(allHighlighted("R2")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
    await bridge("/click", { selector: `button[aria-label="Expand ${label}"]` });
    await until(`!document.querySelector('.fd-board-comparison') && !!document.querySelector('[data-component-ref="R2"]')`);
    const visiblePart = (scope: string) => `(()=>{const root=document.querySelector(${JSON.stringify(scope)}),frame=root.querySelector('.fd-svg-viewport').getBoundingClientRect(),part=root.querySelector('[data-component-ref="R2"]')?.getBoundingClientRect();return !!part&&part.left>=frame.left&&part.right<=frame.right&&part.top>=frame.top&&part.bottom<=frame.bottom})()`;
    await until(visiblePart(".fd-selectable-drawing"));
    check(`Expanding ${label} keeps the selected part visible`, true);
    await bridge("/click", { selector:'button[aria-label="Compare views"]' });
    await until(allHighlighted("R2"));
    await until(visiblePart(`.fd-comparison-pane[data-view="${view}"]`));
    check(`Reopening all views from ${label} preserves a visible selection`, true);
  }
  await choosePart("U1");
  await until(allHighlighted("U1")); await until(`!document.querySelector('[data-focus-motion="running"]')`);
  await bridge("/click", { selector: 'button[aria-label="Expand 3D"]' });
  await until(`!document.querySelector('.fd-board-comparison') && !!document.querySelector('.fd-model-viewport canvas') && !!document.querySelector('.fd-part-picker:not(:disabled)')`);
  check("Expand 3D preserves selection", await selected() === "U1");
  await bridge("/click", { selector: 'button[aria-label="Compare views"]' });
  await until(allHighlighted("U1")); check("All views can be reopened from 3D with the shared selection", true);
  await page(`document.querySelector('.fd-comparison-pane[data-view="pcb"] .fd-svg-host').focus()`); await bridge("/key", { key: "Escape" });
  await until(`!document.querySelector('[data-component-ref]') && document.querySelector('.fd-model-viewport canvas')?.dataset.selectedComponent===''`);
  check("Escape clears all three visible highlights and removes model tint", await page(`document.querySelector('.fd-model-viewport canvas')?.dataset.tintedMeshes==='0'`));
  await bridge("/click", { selector: 'button[aria-label="Single view, close comparison"]' });

}
await page(`window.__motionObserver?.disconnect()`);
check("No uncaught renderer errors", (await page("window.__selectionErrors")).length === 0);
console.log(`All ${passed} passed · ${baseline ? "main baseline" : "feature"} · ${JSON.stringify((await bridge('/state')).ui.page)}`);
