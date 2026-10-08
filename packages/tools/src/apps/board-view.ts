/**
 * `ui://fabdesk/boards`: the fabPlane Boards viewer. Project list, PCB and schematic SVGs, the 3D
 * board (GLB) and CAD drawings (DXF, SVG, STL, GLB). Opens from a model tool call, the host sidebar
 * (global entrypoint), a thread tab, or a matching file (file entrypoint).
 */
import { appHtml, brandHeading } from "./shell";

/** three.js for the 3D tab only; 2D views work when the CDN is unreachable. */
export const THREE_CDN = "https://cdn.jsdelivr.net";
const THREE_VERSION = "0.170.0";
const THREE_BASE = `${THREE_CDN}/npm/three@${THREE_VERSION}`;

/**
 * Subresource integrity for every module the 3D tab loads from the CDN, three's own imports
 * included (GLTFLoader pulls in BufferGeometryUtils). Chromium (and Safari / Firefox recently)
 * enforce `integrity` in import maps, so a tampered CDN file fails to load instead of running in
 * the view; hosts without support ignore it. Bumping THREE_VERSION means recomputing these:
 * `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const THREE_INTEGRITY: Record<string, string> = {
  [`${THREE_BASE}/build/three.module.js`]:
    "sha384-GY5FqjttLCFRt/McQbyaVdCk2O1IQtOeX8Py6NfD89BIAsIyJFRl4UgSXrk2vXAk",
  [`${THREE_BASE}/examples/jsm/controls/OrbitControls.js`]:
    "sha384-aJoe4qqS/DgF2jh9njAuvA6QIveJYoCuYOfYjdFY8P3eawzmc9bEQ40jq2TvOyuP",
  [`${THREE_BASE}/examples/jsm/loaders/STLLoader.js`]:
    "sha384-1EfRoRFlW0okJLwii+CC5clEMVSDeI/MFRIPbyUpGQnNQP+Szo3cgWrhC6r9rHBg",
  [`${THREE_BASE}/examples/jsm/loaders/GLTFLoader.js`]:
    "sha384-Lq1Wl94so5JCKGDvezrdVMJhdeKQkwb8iwRo59QrPPd61CnrCJZLxYmFlQ8ZuOKR",
  [`${THREE_BASE}/examples/jsm/utils/BufferGeometryUtils.js`]:
    "sha384-wOjwauvHlJO7K6APr7FmMGH2nupQa3Ndzas9bJZhsAMOK055efJud8ns4aYmASKv",
};

const BODY = `
<div class="bar">
  ${brandHeading("Boards")}
  <select id="project" aria-label="Project"></select>
  <span id="badges"></span>
  <span class="grow"></span>
  <button id="refresh" title="Re-render from the KiCad files">Re-render</button>
  <button id="drc" title="Run KiCad DRC">Run DRC</button>
  <button id="ask" class="primary" title="Ask the agent about this board">Ask agent</button>
</div>
<div class="tabs" role="tablist" id="tabs"></div>
<div id="files" class="bar small" hidden></div>
<div class="stage" id="stage"><div class="empty">Loading…</div></div>
<div class="status" id="status" role="status" aria-live="polite"></div>
`;

const SCRIPT = String.raw`
var VIEWS = [["pcb", "PCB"], ["schematic", "Schematic"], ["3d", "3D"], ["drawings", "CAD drawings"]];
var state = { projects: [], project: null, view: "pcb", drawing: null, file: null, sheet: 0 };
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), statusEl = $("status"), three = null;

function setStatus(text, cls) { statusEl.className = "status " + (cls || ""); statusEl.textContent = text || ""; }
function current() { return state.projects.find(function (p) { return p.id === state.project; }) || null; }
function busy(on) {
  ["refresh", "drc", "ask"].forEach(function (id) { $(id).disabled = on || (!state.project && !state.file); });
  $("project").disabled = on;
  $("tabs").querySelectorAll("button").forEach(function (el) { el.disabled = on; });
}

function disposeThree() { if (three) { three.dispose(); three = null; } }

function renderTabs() {
  mount($("tabs"), h("div", { style: "display:contents" }, VIEWS.map(function (v) {
    return h("button", { role: "tab", "aria-selected": state.view === v[0] ? "true" : "false", onclick: function () { select(state.project, v[0]); } }, v[1]);
  })));
  $("tabs").hidden = !!state.file;
}

function renderProjects() {
  var sel = $("project");
  mount(sel, h("optgroup", { label: "Projects" }, state.projects.map(function (p) {
    return h("option", { value: p.id, selected: p.id === state.project }, p.name);
  })));
  sel.hidden = !!state.file || state.projects.length === 0;
  var p = current();
  mount($("badges"), h("span", {},
    p && p.lastDrc ? h("span", { class: "pill " + (p.lastDrc.errors ? "err" : "ok") }, "DRC " + p.lastDrc.errors + " err / " + p.lastDrc.warnings + " warn") : null,
    p && p.lastRoute ? h("span", { class: "pill" }, "route " + p.lastRoute.status + (p.lastRoute.open != null ? " · " + p.lastRoute.open + " open" : "")) : null));
}

function showSvg(sheets, title) {
  disposeThree();
  var sheet = sheets[Math.min(state.sheet, sheets.length - 1)];
  // An <img> SVG cannot inherit color: give DXF strokes (currentColor) the theme's text color.
  var svg = sheet.svg.replace(/currentColor/g, getComputedStyle(document.body).color);
  var img = h("img", { alt: title || "drawing", draggable: "false", src: svgDataUrl(svg) });
  var nav = sheets.length > 1 ? h("div", { class: "bar small", style: "position:absolute;left:0;top:0;border:0" },
    sheets.map(function (s, i) { return h("button", { "aria-pressed": String(i === state.sheet), onclick: function () { state.sheet = i; showSvg(sheets, title); } }, s.name); })) : null;
  var zoom = h("div", { style: "position:absolute;right:8px;top:8px;display:flex;gap:4px" });
  mount(stage, h("div", { style: "display:contents" }, img, nav, zoom, h("div", { class: "hint" }, "drag to pan · wheel/pinch to zoom · double-click to fit")));
  var pz = panZoom(stage, img);
  zoom.append(h("button", { onclick: function () { pz.zoom(1.25); } }, "+"), h("button", { onclick: function () { pz.zoom(0.8); } }, "−"), h("button", { onclick: pz.fit }, "Fit"));
  if (img.complete) pz.fit(); else img.addEventListener("load", pz.fit);
}

async function showMesh(bytes, format) {
  disposeThree();
  mount(stage, h("div", { class: "empty" }, "Loading 3D viewer…"));
  var THREE = await import("three");
  var controls = await import("three/addons/controls/OrbitControls.js");
  var obj;
  if (format === "stl") {
    var stl = await import("three/addons/loaders/STLLoader.js");
    var geom = new stl.STLLoader().parse(bytes.buffer);
    geom.computeVertexNormals();
    obj = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.1, roughness: 0.6 }));
    // STL (like most CAD) is Z-up; three.js and glTF are Y-up.
    obj.rotation.x = -Math.PI / 2;
  } else {
    var gltf = await import("three/addons/loaders/GLTFLoader.js");
    obj = await new Promise(function (res, rej) { new gltf.GLTFLoader().parse(bytes.buffer, "", function (g) { res(g.scene); }, rej); });
  }
  var canvas = h("canvas");
  mount(stage, h("div", { style: "display:contents" }, canvas, h("div", { class: "hint" }, "drag to orbit · right-drag to pan · wheel to zoom")));
  // Frames are drawn on demand; keep the last one so host snapshots / thumbnails are not blank.
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  var scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
  var sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(1, 2, 3); scene.add(sun);
  scene.add(obj);
  var box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  var radius = Math.max(size.x, size.y, size.z) || 1;
  var camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
  camera.position.copy(center).add(new THREE.Vector3(radius * 0.8, radius * 0.9, radius * 1.4));
  var orbit = new controls.OrbitControls(camera, canvas); orbit.target.copy(center); orbit.update();
  var frame = 0;
  function draw() { frame = 0; renderer.render(scene, camera); }
  function queue() { if (!frame) frame = requestAnimationFrame(draw); }
  function resize() { var w = stage.clientWidth, hh = stage.clientHeight; renderer.setSize(w, hh, false); camera.aspect = w / Math.max(hh, 1); camera.updateProjectionMatrix(); queue(); }
  orbit.addEventListener("change", queue);
  var ro = new ResizeObserver(resize); ro.observe(stage); resize();
  three = { dispose: function () { ro.disconnect(); orbit.dispose(); renderer.dispose(); } };
}

function showPreview(res) {
  if (res.notes && res.notes.length) setStatus(res.notes.join(" · "), "warn");
  else setStatus(res.title || "");
  if (res.kind === "svg") return showSvg(res.sheets, res.title);
  if (res.kind === "mesh") return showMesh(b64ToBytes(res.data), res.format).catch(function (e) {
    mount(stage, h("div", { class: "empty" }, "3D viewer unavailable: " + e.message));
  });
  mount(stage, h("div", { class: "empty" }, res.message || "Nothing to show."));
}

function renderDrawings(p) {
  var bar = $("files");
  var files = (p && p.cadFiles) || [];
  bar.hidden = state.view !== "drawings" || !!state.file;
  mount(bar, h("div", { style: "display:contents" },
    files.length ? files.map(function (f) {
      return h("button", { "aria-pressed": String(f === state.drawing), onclick: function () { state.drawing = f; load(); } }, f);
    }) : h("span", { class: "muted" }, "No CAD drawings yet."),
    h("span", { class: "grow" }),
    h("button", { onclick: generateEnclosure, title: "Parametric case from the board outline, holes and connectors" }, "Generate enclosure"),
    p && p.hasCadModel ? h("button", { onclick: exportCad, title: "FreeCAD model.FCStd → exports/model.stl" }, "Export FreeCAD model") : null,
    p && p.hasCadModel ? h("button", { onclick: openFreecad, title: "The live FreeCAD web UI on this project's session" }, "Open in FreeCAD") : null,
    h("button", { onclick: exportDxf, title: "kicad-cli: copper and Edge.Cuts DXF" }, "Export DXF")));
}

/** Run an export, refresh the file list and show the file it wrote. */
async function exportAndShow(label, tool, args, pickFile) {
  var p = current(); if (!p) return;
  busy(true); setStatus(label + "…");
  try {
    args.project = p.id;
    var res = await fab.call(tool, args);
    await refreshProjects();
    state.drawing = pickFile(res) || state.drawing;
    await load();
  } catch (e) { setStatus(e.message, "err"); } finally { busy(false); }
}
function exportDxf() { return exportAndShow("Exporting DXF", "export_dxf", {}, function (r) { return r.files && r.files[0]; }); }
function exportCad() { return exportAndShow("Exporting the FreeCAD model", "cad_export", { format: "stl", name: "model" }, function (r) { return r.path; }); }
function generateEnclosure() { return exportAndShow("Generating enclosure", "cad_enclosure", { action: "generate" }, function (r) { return r.stl; }); }

async function openFreecad() {
  var p = current(); if (!p) return;
  try {
    var v = await fab.call("cad_view", { project: p.id });
    if (!v.uiUrl) return setStatus("The FreeCAD bridge serves no web UI (" + v.bridgeUrl + ").", "warn");
    await fab.openLink(v.uiUrl);
  } catch (e) { setStatus(e.message, "err"); }
}

async function load(refresh) {
  var p = current();
  renderTabs(); renderProjects(); renderDrawings(p);
  if (state.file) return loadFile();
  if (!p) { busy(false); mount(stage, h("div", { class: "empty" }, state.projects.length ? "Pick a project." : "No fabPlane projects yet. Create one in the fabPlane app or ask the agent.")); return; }
  if (state.view === "drawings" && !state.drawing) state.drawing = (p.cadFiles || [])[0] || null;
  if (state.view === "drawings" && !state.drawing) { mount(stage, h("div", { class: "empty" }, p.hasCadModel ? "Export the FreeCAD model or DXF artwork to see them here." : "Export DXF artwork, or add .dxf / .stl / .glb files under exports/, mechanical/ or cad/.")); return; }
  mount(stage, h("div", { class: "empty" }, "Rendering…"));
  busy(true); setStatus("");
  try {
    var args = { project: p.id, view: state.view === "drawings" ? "drawing" : state.view };
    if (state.view === "drawings") args.path = state.drawing;
    if (refresh) args.refresh = true;
    showPreview(await fab.call("preview", args));
  } catch (e) {
    mount(stage, h("div", { class: "empty err" }, h("p", {}, "Could not load this view."), h("p", { class: "small" }, e.message), h("button", { onclick: function () { load(true); } }, "Try again"))); setStatus("");
  } finally { busy(false); }
}

async function loadFile() {
  $("refresh").hidden = true; $("drc").hidden = true;
  mount(stage, h("div", { class: "empty" }, "Opening " + state.file.name + "…"));
  try {
    showPreview(await fab.call("host_file", { file: state.file }));
  } catch (e) {
    // Hosts without the openai/resource path hint: read the file through the host instead.
    try {
      var r = await fab.request("resources/read", { uri: state.file.resourceUri });
      var c = (r.contents || [])[0] || {};
      var ext = state.file.name.toLowerCase().split(".").pop();
      if (ext === "stl" || ext === "glb") return showPreview({ kind: "mesh", format: ext, data: c.blob || btoa(c.text || ""), title: state.file.name });
      if (ext === "dxf" || ext === "svg") return showPreview(await fab.call("convert", { name: state.file.name, text: c.text != null ? c.text : atob(c.blob || "") }));
      throw e;
    } catch (e2) { mount(stage, h("div", { class: "empty err" }, e2.message || e.message)); }
  }
}

async function refreshProjects() {
  var res = await fab.call("projects", {});
  state.projects = res.projects || [];
}

function select(id, view) {
  var changed = id !== state.project;
  state.project = id; if (view) state.view = view;
  if (changed) { state.drawing = null; state.sheet = 0; }
  var p = current();
  if (p) fab.setContext("The user is viewing fabPlane project \"" + p.name + "\" (project=\"" + p.id + "\", view: " + state.view + ") in the fabPlane Boards viewer. Pass project=\"" + p.id + "\" to fabdesk tools.", "fabPlane: " + p.name);
  load();
}

function applyDeepLink() {
  var url = fab.deepLink(); if (!url) return false;
  var m = /^\/project\/([^/?#]+)(?:\/(pcb|schematic|3d|drawings))?/.exec(url);
  if (!m) return false;
  select(decodeURIComponent(m[1]), m[2] || state.view);
  return true;
}

function applyInput(sc, args) {
  sc = sc || {}; args = args || {};
  if (args.file && args.file.resourceUri) { state.file = args.file; return load(); }
  if (sc.projects) state.projects = sc.projects;
  if (sc.drawing) state.drawing = sc.drawing;
  select(sc.project || state.project || (state.projects[0] && state.projects[0].id) || null, sc.view || args.view || state.view);
}

var toolArgs = {};
fab.on("ui/notifications/tool-input", function (p) { toolArgs = p.arguments || {}; if (toolArgs.file) { state.file = toolArgs.file; load(); } });
fab.on("ui/notifications/tool-result", function (res) { if (!res.isError) applyInput(res.structuredContent, toolArgs); else setStatus(fab.textOf(res), "err"); });
fab.on("ui/notifications/host-context-changed", function (p) { if (p["openai/deepLink"]) applyDeepLink(); });

$("project").addEventListener("change", function (e) { select(e.target.value); });
$("refresh").addEventListener("click", function () { load(true); });
$("ask").addEventListener("click", function () {
  var p = current();
  var subject = state.file ? "the file " + state.file.name : p ? "fabPlane project \"" + p.name + "\" (project=\"" + p.id + "\")" : "my fabPlane boards";
  fab.message("Take a look at " + subject + " in the fabPlane " + (state.view === "drawings" ? "CAD drawings" : state.view) + " view and tell me what needs attention.").catch(function (e) { setStatus(e.message, "err"); });
});
$("drc").addEventListener("click", async function () {
  var p = current(); if (!p) return;
  busy(true); setStatus("Running DRC…");
  try {
    var r = await fab.call("verify_drc", { project: p.id, schematicParity: !!p.hasSchematic });
    var c = r.counts || {};
    setStatus("DRC: " + (c.errors || 0) + " errors, " + (c.warnings || 0) + " warnings, " + (c.unconnected || 0) + " unconnected", c.errors ? "err" : "ok");
    await refreshProjects(); renderProjects();
  } catch (e) { setStatus(e.message, "err"); } finally { busy(false); }
});

fab.connect("fabplane-boards").then(async function () {
  // Entrypoints (sidebar, thread tab) open without a model call: fetch the project list ourselves.
  await refreshProjects().catch(function (e) { setStatus(e.message, "err"); });
  if (state.file) return;
  if (!applyDeepLink() && !state.project) applyInput({}, toolArgs);
}).catch(function (e) { mount(stage, h("div", { class: "empty" }, e.message)); });
renderTabs();
`;

export function boardViewHtml(): string {
  return appHtml({
    title: "fabPlane Boards",
    head: `<script type="importmap">${JSON.stringify({
      imports: {
        three: `${THREE_BASE}/build/three.module.js`,
        "three/addons/": `${THREE_BASE}/examples/jsm/`,
      },
      integrity: THREE_INTEGRITY,
    })}</script>`,
    body: BODY,
    script: SCRIPT,
  });
}
