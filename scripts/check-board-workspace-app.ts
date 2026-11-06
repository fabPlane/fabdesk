/**
 * Clicks through History and Connections in a running dev app (`bun run dev`), with real input
 * through the automation bridge, on a throwaway project it creates and removes.
 *
 *   bun run check:board-workspace
 *
 * Keep the app window visible: a fully covered window receives no input. The unit tests cover the
 * logic; this covers what only the real screens can show, such as a button doing what it says.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const userData = process.env.FABDESK_USER_DATA ?? join(process.env.APPDATA ?? (process.platform === "darwin" ? join(homedir(), "Library/Application Support") : join(homedir(), ".config")), "fabPlane Dev");
const readJson = async (name: string) => JSON.parse(await Bun.file(join(userData, name)).text());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function bridge(method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    const { url } = await readJson("app-bridge.json");
    const { token } = await readJson("daemon.json");
    const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    // The bridge refuses requests while the core restarts.
    if (response.status === 401 && attempt < 40) { await sleep(1000); continue; }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }
}
async function core(path: string, init: RequestInit = {}): Promise<Response> {
  const { port, token } = await readJson("daemon.json");
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
}
const page = async (code: string): Promise<any> => (await bridge("POST", "/eval", { code })).result;
async function visible() {
  for (let waited = 0; waited < 30; waited += 1) {
    if ((await page("document.visibilityState")) === "visible") return;
    if (waited === 0) console.log("Waiting for the app window to be visible…");
    await sleep(1000);
  }
  throw new Error("The app window stayed hidden, so it cannot receive clicks.");
}
const clickSelector = async (selector: string) => { await visible(); return bridge("POST", "/click", { selector }); };
async function clickButton(label: string, within = "body") {
  const found = await page(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(`${within} button`)})].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})&&e.offsetParent);if(!el)return false;el.setAttribute("data-check-target","1");return true})()`);
  if (!found) throw new Error(`No button "${label}" in ${within}`);
  await clickSelector('[data-check-target="1"]');
  await page(`document.querySelector('[data-check-target="1"]')?.removeAttribute("data-check-target")`);
}
async function until(code: string, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page(code)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${code}`);
}
const setSelect = (label: string, value: string) => page(`(()=>{const s=document.querySelector('select[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
const text = (selector: string) => page(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
async function openArea(label: string) {
  await page(`(()=>{const d=document.querySelector(".fd-canvas-destinations details");if(d&&!d.open)d.querySelector("summary").click()})()`);
  await sleep(150);
  await clickButton(label, ".fd-canvas-destinations");
}
async function closeProject() {
  if (!(await page(`!!document.querySelector("[role=dialog]")`))) await clickButton("Home", ".fd-canvas-header");
  await until(`[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('Close project'))`, 10000);
  await clickButton("Close project", "[role=dialog]");
  await sleep(1000);
}

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes += 1; else failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}

// Two small boards. J1 and J9 share SDA and GND; +3V3 only exists on J1, +5V only on J9.
const pad = (pin: string, x: number, net: string) => `(pad "${pin}" smd rect (at ${x} 0) (size 1.2 1.2) (layers "F.Cu") (net 1 "${net}"))`;
const part = (ref: string, x: number, y: number, pads: string[], footprint = "Lib:Part") => `(footprint "${footprint}" (layer "F.Cu") (uuid "${ref}-uuid") (at ${x} ${y} 0)
    (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "v" (at 0 0 0))
    ${pads.join("\n    ")})`;
const pcb = (...parts: string[]) => `(kicad_pcb (version 20241201)
  ${parts.join("\n  ")}
  (gr_rect (start 0 0) (end 60 40) (stroke (width 0.1)) (layer "Edge.Cuts")))`;
const connectorA = (x = 15) => part("J1", x, 10, [pad("1", -3, "GND"), pad("2", -1, "+3V3"), pad("3", 1, "SDA"), pad("4", 3, "SCL")], "Connector:Header_1x04");
const connectorB = part("J9", 30, 20, [pad("1", -3, "SDA"), pad("2", -1, "+5V"), pad("3", 1, "GND"), pad("4", 3, "OTHER")], "Connector:Header_1x04");
const resistor = (ref: string, x: number) => part(ref, x, 30, [pad("1", -1, "SDA"), pad("2", 1, "SIG")]);
const BOARD_A = "boards/a/a.kicad_pcb", BOARD_B = "boards/b/b.kicad_pcb";

const parent = mkdtempSync(join(tmpdir(), "fd-board-check-"));
const previous = (await bridge("GET", "/state")).ui.activeProjectId as string | null;
let projectId: string | null = null;
try {
  const created = await (await core("/projects", { method: "POST", body: JSON.stringify({ name: `Board workspace check ${Date.now()}`, parentDirectory: parent }) })).json() as { id: string; path: string };
  projectId = created.id;
  const dir = created.path;
  const write = (path: string, content: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); };
  const git = (...args: string[]) => { const run = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Check", "-c", "user.email=check@example.invalid", ...args]); if (run.exitCode) throw new Error(run.stderr.toString()); };
  git("init", "-q");
  write(BOARD_A, pcb(connectorA(), resistor("R1", 30), resistor("R2", 40)));
  write(BOARD_B, pcb(connectorB, resistor("R5", 10)));
  git("add", "-A"); git("commit", "-qm", "First");
  write(BOARD_A, pcb(connectorA(), resistor("R1", 33), resistor("R3", 50)));
  git("add", "-A"); git("commit", "-qm", "Second");
  write(BOARD_A, pcb(connectorA(), resistor("R1", 36), resistor("R3", 50)));
  git("add", "-A"); git("commit", "-qm", "Third");

  if (previous) await closeProject();
  await bridge("POST", "/ui", { action: "selectProject", args: [projectId] });
  await sleep(1200);

  // ---- History
  await openArea("History");
  await until(`!!document.querySelector('select[aria-label="Board"]')`);
  await setSelect("Board", BOARD_A);
  await until(`document.querySelectorAll('.fd-history-card').length===3`);
  await until(`!!document.querySelector('.fd-history-step')`);
  await until(`document.querySelectorAll('[data-testid="pair-newer-revision"] canvas').length===1`);
  const step = () => text(".fd-history-step [aria-live]");
  check("History opens on the newest step", (await step()) === "Step 2 of 2", await step());
  await clickSelector('[aria-label="Step to older revision"]');
  await until(`document.querySelector('.fd-history-step [aria-live]').innerText==='Step 1 of 2'`, 5000);
  await until(`!document.querySelector('.fd-pair-view[data-updating=true]')`);
  const filters = await text(".fd-history-filters");
  check("Stepping back shows that step's added and removed parts", filters.includes("Added") && filters.includes("Removed"), filters);
  check("Connectors are marked on the boards", (await page(`document.querySelectorAll('[data-testid="pair-newer-revision"] .fd-part-marker[data-tone=connector]').length`)) === 1);
  await clickSelector('[aria-label="Step to newer revision"]');
  await until(`document.querySelector('.fd-history-step [aria-live]').innerText==='Step 2 of 2'`, 5000);
  check("Stepping forward returns", true);
  await sleep(300);
  await page(`document.activeElement?.blur()`);
  await visible();
  await bridge("POST", "/key", { key: "Left" });
  await sleep(400);
  check("Left arrow steps back", (await step()) === "Step 1 of 2", await step());
  await bridge("POST", "/key", { key: "Right" });
  await sleep(400);

  // ---- Connections
  await openArea("Connections");
  await until(`document.querySelectorAll('[data-testid="connections-workspace"] canvas').length===2`);
  await sleep(300);
  await setSelect("Left board", BOARD_A);
  await until(`document.querySelectorAll('[data-testid="connections-workspace"] canvas').length===2`);
  await setSelect("Right board", BOARD_B);
  await until(`document.querySelectorAll('[data-testid="connections-workspace"] canvas').length===2`);
  await sleep(500);
  const tool = async (name: string, args: Record<string, unknown>) => ((await (await core(`/tools/${name}`, { method: "POST", body: JSON.stringify({ project: projectId, args }) })).json()) as any).json;
  const viewA = await tool("board_view", { pcbPath: BOARD_A, drawing: true }), viewB = await tool("board_view", { pcbPath: BOARD_B, drawing: true });
  check("board_view reports status and connectors to agents", viewA.parts.find((p: any) => p.ref === "J1").connector === true && viewA.parts.find((p: any) => p.ref === "R1").status === "changed" && viewA.parts.find((p: any) => p.ref === "R3").status === "existing", viewA.parts.map((p: any) => [p.ref, p.status, p.connector]));
  const clickPart = async (panel: string, svg: string, bounds: any) => {
    await visible();
    const box = /viewBox="([^"]+)"/.exec(svg)![1]!.trim().split(/\s+/).map(Number);
    const rect = await page(`(()=>{const r=document.querySelector('[data-testid="${panel}"] .fd-svg-host').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`);
    const x = rect.left + (((bounds.minX + bounds.maxX) / 2 - box[0]!) / box[2]!) * rect.width, y = rect.top + (((bounds.minY + bounds.maxY) / 2 - box[1]!) / box[3]!) * rect.height;
    await bridge("POST", "/click", { x: Math.round(x), y: Math.round(y) });
  };
  const hostSize = (panel: string) => page(`(()=>{const r=document.querySelector('[data-testid="${panel}"] .fd-svg-host').getBoundingClientRect();return Math.round(r.width)+"x"+Math.round(r.height)})()`);
  const before = await hostSize("pair-left-board");
  const j1 = viewA.parts.find((p: any) => p.ref === "J1"), j9 = viewB.parts.find((p: any) => p.ref === "J9");
  await clickPart("pair-left-board", viewA.drawing, j1.bounds);
  await until(`document.querySelector('.fd-connect-panel h2')?.innerText==='J1'`, 5000);
  check("Clicking a part opens where it connects", true);
  await sleep(300);
  check("Selecting does not resize the board", (await hostSize("pair-left-board")) === before, [before, await hostSize("pair-left-board")]);
  const candidates: string[] = await page(`[...document.querySelectorAll('[data-testid="pair-right-board"] .fd-part-marker[data-tone=candidate]')].length`);
  check("Parts sharing a signal net are marked as likely matches", Number(candidates) === 2, candidates);
  await clickPart("pair-right-board", viewB.drawing, j9.bounds);
  await until(`!!document.querySelector('.fd-connect-pin-table')`, 5000);
  await sleep(300);
  check("Net names fill in a starting pin map", (await page(`document.querySelector('select[aria-label="Pin on J9 for pin 1"]').value`)) === "3");
  check("A line joins the pins across the boards", Number(await page(`document.querySelector('.fd-pair-lines')?.dataset.lineCount ?? 0`)) >= 2, await page(`document.querySelector('.fd-pair-lines')?.outerHTML?.slice(0,200) ?? null`));
  // Each end of a line must land on its pad, on screen, not merely exist.
  const lineEnds = await page(`(()=>{const svg=document.querySelector('.fd-pair-lines');const o=svg.getBoundingClientRect();const pads=[...document.querySelectorAll('.fd-pin-marker')].map(p=>p.getBoundingClientRect());return [...svg.querySelectorAll('circle')].map(c=>{const x=o.left+Number(c.getAttribute('cx')),y=o.top+Number(c.getAttribute('cy'));return pads.some(r=>x>=r.left-2&&x<=r.right+2&&y>=r.top-2&&y<=r.bottom+2)})})()`);
  check("Each line ends on its pin", lineEnds.length >= 4 && lineEnds.every(Boolean), lineEnds);
  await setSelect("Pin on J9 for pin 2", "2");
  await sleep(250);
  check("Joining different power nets is flagged", (await text('.fd-connect-check[data-check="conflict"]')) !== null, await text(".fd-connect-check"));
  check("The conflicting pin's line turns red", (await page(`document.querySelectorAll('.fd-pair-line[data-tone=conflict]').length`)) === 1);
  await setSelect("Pin on J9 for pin 2", "");
  await sleep(200);
  await clickButton("Save connection", ".fd-connect-panel");
  await until(`document.querySelectorAll('.fd-connection-list > button').length===1`, 15000);
  const file = () => JSON.parse(readFileSync(join(dir, "fabplane.connections.json"), "utf8")).links;
  check("The connection and its pins are saved", file()[0].a.ref === "J1" && file()[0].b.ref === "J9" && file()[0].pins.some((row: any) => row.a === "1" && row.b === "3"), file()[0]);
  await until(`document.querySelectorAll('[data-testid="pair-left-board"] .fd-part-marker[data-tone=linked]').length===1`, 5000);
  check("A connected part is marked and names its partner", (await text('[data-testid="pair-left-board"] .fd-part-chip')) === "→ J9", await text('[data-testid="pair-left-board"] .fd-part-chip'));

  // A change to the linked part asks for review; Mark reviewed must actually clear it.
  write(BOARD_A, pcb(connectorA(18), resistor("R1", 36), resistor("R3", 50)));
  await until(`document.querySelector('.fd-connection-list > button')?.innerText.includes('Needs review')`, 20000);
  check("Moving a linked part asks for review", (await page(`document.querySelectorAll('.fd-pair-line[data-tone=review]').length + document.querySelectorAll('.fd-part-marker[data-tone=review]').length`)) >= 1);
  await clickButton("J1 ↔ J9", ".fd-connection-list");
  await until(`[...document.querySelectorAll('.fd-connect-actions button')].some(b=>b.textContent.includes('Mark reviewed'))`, 10000);
  await clickButton("Mark reviewed", ".fd-connect-panel");
  await until(`!document.querySelector('.fd-connection-list > button')?.innerText.includes('Needs review')`, 10000);
  check("Mark reviewed clears the review", true);
  await clickButton("Remove link", ".fd-connect-panel");
  await until(`document.querySelectorAll('.fd-connection-list > button').length===0`, 10000);
  check("Remove link deletes it", file().length === 0, file());

  // A first link started from the right board must leave both boards where they are.
  await openArea("History");
  await until(`!!document.querySelector('.fd-history-step')`);
  await openArea("Connections");
  await until(`document.querySelectorAll('[data-testid="connections-workspace"] canvas').length===2`);
  await sleep(500);
  const boardsShown = () => page(`[...document.querySelectorAll('.fd-connection-side select')].filter((_,i)=>i%2===0).map(s=>s.value).join()`);
  const opening = await boardsShown();
  await clickPart("pair-right-board", viewB.drawing, j9.bounds);
  await until(`document.querySelector('.fd-connect-panel h2')?.innerText==='J9'`, 5000);
  await sleep(300);
  await clickPart("pair-left-board", viewA.drawing, j1.bounds);
  await until(`!!document.querySelector('.fd-connect-pin-table')`, 5000);
  await sleep(300);
  const saveVisible = await page(`(()=>{const p=document.querySelector('.fd-connect-panel').getBoundingClientRect(),b=document.querySelector('.fd-connect-actions button').getBoundingClientRect();return b.bottom<=p.bottom+1})()`);
  check("Save stays in view", saveVisible === true);
  await clickButton("Save connection", ".fd-connect-panel");
  await until(`document.querySelectorAll('.fd-connection-list > button').length===1`, 15000);
  await sleep(1000);
  check("Saving keeps both boards and the selection", (await boardsShown()) === opening && (await page(`document.querySelectorAll('.fd-pair-notice').length`)) === 0, [opening, await boardsShown()]);
  await clickButton("Remove link", ".fd-connect-panel");
  await until(`document.querySelectorAll('.fd-connection-list > button').length===0`, 10000);
  await sleep(500);
  check("Removing the last link keeps both boards", (await boardsShown()) === opening, [opening, await boardsShown()]);

  // Arrow keys still step after clicking a part, which is how one part is followed through history.
  await openArea("History");
  await until(`document.querySelectorAll('[data-testid="pair-newer-revision"] canvas').length===1`);
  await until(`!!document.querySelector('.fd-history-step [aria-live]') && !document.querySelector('.fd-pair-view[data-updating=true]')`, 5000);
  const stepNumber = async () => Number(/Step (\d+)/.exec(await step())?.[1]);
  const startStep = await stepNumber();
  const r1 = viewA.parts.find((p: any) => p.ref === "R1");
  await clickPart("pair-newer-revision", (await tool("board_revision_compare", { pcbPath: BOARD_A, from: (await tool("board_revision_timeline", { pcbPath: BOARD_A })).entries.at(-2).ref, drawings: true })).to.drawing, r1.bounds);
  await until(`document.querySelector('.fd-history-selection')?.innerText.startsWith('R1')`, 5000);
  await bridge("POST", "/key", { key: "Left" });
  await sleep(400);
  check("Left arrow steps back after clicking a part", (await stepNumber()) === startStep - 1, await step());
  check("The part stays selected while stepping", (await text(".fd-history-selection")).startsWith("R1"), await text(".fd-history-selection"));
  // Zoomed in, the drawing can pan, so the same key pans it instead of stepping.
  const zoomIn = '[data-testid="pair-newer-revision"] [title="Zoom in"]';
  for (let times = 0; times < 5; times += 1) await clickSelector(zoomIn);
  await sleep(300);
  const hostCenter = await page(`(()=>{const r=document.querySelector('[data-testid="pair-newer-revision"] .fd-svg-viewport').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  await bridge("POST", "/click", hostCenter);
  const steppedTo = await stepNumber();
  await bridge("POST", "/key", { key: "Right" });
  await sleep(400);
  check("Arrow keys pan a zoomed drawing instead of stepping", (await stepNumber()) === steppedTo, await step());
  await clickButton("Save this revision", ".fd-board-workspace-bar");
  await until(`[...document.querySelectorAll('.fd-board-workspace-bar [role=status]')].some(e=>e.innerText.startsWith('Saved'))`, 10000);
  check("Saving a revision says so", true);
  check("No errors on screen", (await page(`document.querySelectorAll('[role=alert]').length`)) === 0, await page(`[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)`));
} catch (error) {
  failures += 1;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    await closeProject();
    if (projectId) await core(`/projects/${projectId}?purge=true`, { method: "DELETE" });
    if (previous) await bridge("POST", "/ui", { action: "selectProject", args: [previous] });
  } catch (error) {
    console.log(`Cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failures ? `\n${failures} failed, ${passes} passed` : `\nAll ${passes} passed`);
process.exit(failures ? 1 : 0);
