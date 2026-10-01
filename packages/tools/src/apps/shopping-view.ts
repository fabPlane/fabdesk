/**
 * `ui://fabdesk/shopping`: the project's fabplane.com shopping list (BOM cart) grouped by purchase
 * destination, with inline quantity / destination / status edits, BOM sync, a quick-add row and a
 * team-inventory search. Every edit goes through the `shopping` tools via `fabdesk_ui_call`.
 */
import { appHtml, brandHeading } from "./shell";

const BODY = `
<div class="bar">
  ${brandHeading("Shopping list")}
  <select id="project" aria-label="Project"></select>
  <span id="summary" class="muted small"></span>
  <span class="grow"></span>
  <button id="sync" title="Rebuild part lines from the netlist, keeping edits">Sync from BOM</button>
  <button id="open" title="Open the list on fabplane.com">Open on fabplane.com</button>
  <button id="ask" class="primary" title="Ask the agent to source what is still needed">Ask agent to source</button>
</div>
<div id="list"><div class="empty">Loading…</div></div>
<div class="bar small">
  <strong>Add</strong>
  <input id="addQty" type="number" min="1" value="1" style="width:64px" aria-label="Quantity">
  <input id="addPart" placeholder="MPN, value or description" style="flex:1;min-width:160px" aria-label="Part">
  <button id="add">Add line</button>
</div>
<div class="bar small">
  <strong>Inventory</strong>
  <input id="invQ" placeholder="Search the team's parts on hand" style="flex:1;min-width:160px" aria-label="Inventory search">
  <button id="invGo">Search</button>
</div>
<div id="inv"></div>
<div class="status" id="status" role="status" aria-live="polite"></div>
`;

const SCRIPT = String.raw`
var STATUSES = ["needed", "ordered", "received"];
var state = { projects: [], project: null, list: null, destinations: [], signedOut: false, busy: false };
var $ = function (id) { return document.getElementById(id); };
function setStatus(text, cls) { $("status").className = "status " + (cls || ""); $("status").textContent = text || ""; }
function current() { return state.projects.find(function (p) { return p.id === state.project; }) || null; }
function destName(id) { var d = state.destinations.find(function (x) { return x.id === id; }); return d ? d.name : id; }
function partLabel(i) { return i.mpn || i.value || i.description || i.kind; }

function controls() {
  ["sync", "add", "ask"].forEach(function (id) { $(id).disabled = state.busy || state.signedOut || !state.project; });
  ["invGo", "invQ", "addQty", "addPart"].forEach(function (id) { $(id).disabled = state.busy || state.signedOut; });
  $("project").disabled = state.busy;
  $("open").disabled = state.busy || !(state.list && state.list.cartUrl);
  $("list").querySelectorAll("button,input,select").forEach(function (el) { el.disabled = state.busy || (state.signedOut && !el.hasAttribute("data-retry")); });
}
function showError(error) {
  var text = error.message || String(error);
  if (/401|unauthorized|not signed in|sign.in|not connected|authentication required/i.test(text)) {
    state.signedOut = true; state.list = null; $("summary").textContent = "";
    mount($("list"), h("div", { class: "empty" },
      h("p", {}, "Sign in to fabPlane to use shopping lists."),
      h("p", {}, "Open the fabPlane desktop app, go to Settings → Account, and sign in. Then come back here."),
      h("button", { "data-retry": true, onclick: function () { state.signedOut = false; run("Reconnecting", async function () { await loadDestinations(); if (!state.project && state.projects.length) { state.project = state.projects[0].id; renderProjects(); describe(); } await reload(); }); } }, "I've signed in — retry")));
    setStatus("");
  } else { setStatus(text, "err"); }
  controls();
}
async function run(label, fn) {
  if (state.busy) return;
  state.busy = true; controls(); setStatus(label + "…");
  try { await fn(); setStatus(""); } catch (e) { showError(e); }
  finally { state.busy = false; controls(); }
}

function renderProjects() {
  mount($("project"), h("optgroup", { label: "Projects" }, state.projects.map(function (p) {
    return h("option", { value: p.id, selected: p.id === state.project }, p.name);
  })));
}

function renderList() {
  controls();
  var list = state.list, cart = list && list.cart;
  $("open").disabled = !(list && list.cartUrl);
  if (!state.project) { mount($("list"), h("div", { class: "empty" }, "No fabPlane projects yet.")); return; }
  if (!cart) {
    $("summary").textContent = "";
    mount($("list"), h("div", { class: "empty" }, "No shopping list for this project yet. ", h("button", { class: "primary", onclick: sync }, "Build it from the BOM")));
    return;
  }
  var needed = cart.items.filter(function (i) { return i.status === "needed"; }).length;
  $("summary").textContent = plural(cart.items.length, "line") + " · " + needed + " still needed";
  var groups = {};
  cart.items.forEach(function (i) { (groups[i.destinationId] = groups[i.destinationId] || []).push(i); });
  var ids = Object.keys(groups);
  mount($("list"), h("div", {}, ids.map(function (dest) {
    return h("section", { class: "pad" },
      h("h2", { style: "font-size:13px;margin:0 0 6px" }, destName(dest), " ", h("span", { class: "muted small" }, plural(groups[dest].length, "line"))),
      h("table", {},
        h("thead", {}, h("tr", {}, ["Qty", "Part", "Footprint", "Refs", "Destination", "Status", ""].map(function (t) { return h("th", {}, t); }))),
        h("tbody", {}, groups[dest].map(row))));
  })));
}

function row(i) {
  var qty = h("input", { type: "number", min: "0", value: String(i.quantity), style: "width:64px", "aria-label": "Quantity",
    onchange: function (e) { update(i, { quantity: Number(e.target.value) }); } });
  var dest = h("select", { "aria-label": "Destination", onchange: function (e) { update(i, { destination: e.target.value }); } },
    state.destinations.map(function (d) { return h("option", { value: d.id, selected: d.id === i.destinationId }, d.name); }));
  var status = h("select", { "aria-label": "Status", onchange: function (e) { update(i, { status: e.target.value }); } },
    STATUSES.map(function (s) { return h("option", { value: s, selected: s === i.status }, s); }));
  return h("tr", {},
    h("td", {}, qty),
    h("td", {}, h("div", {}, partLabel(i)), i.manufacturer ? h("div", { class: "muted small" }, i.manufacturer) : null,
      i.url ? h("a", { href: "#", class: "small", onclick: function (e) { e.preventDefault(); fab.openLink(i.url); } }, i.sku || "product page") : (i.sku ? h("div", { class: "muted small mono" }, i.sku) : null)),
    h("td", { class: "small mono" }, i.footprint ? i.footprint.split(":").pop() : ""),
    h("td", { class: "small" }, (i.refs || []).join(" ")),
    h("td", {}, dest),
    h("td", {}, status),
    h("td", {}, h("button", { title: "Remove line", "aria-label": "Remove line", onclick: function () { remove(i); } }, "✕")));
}

function update(item, patch) {
  run("Saving", async function () {
    patch.project = state.project; patch.itemId = item.id;
    await fab.call("shopping_list_update", patch);
    await reload();
  });
}
function remove(item) {
  run("Removing", async function () { await fab.call("shopping_list_remove", { project: state.project, itemId: item.id }); await reload(); });
}
function sync() {
  run("Syncing from the BOM", async function () {
    state.list = await fab.call("shopping_list_sync_bom", { project: state.project });
    renderList();
  });
}

async function reload() {
  if (!state.project) return renderList();
  state.list = await fab.call("shopping_list_get", { project: state.project });
  renderList();
}

async function loadDestinations() {
  var res = await fab.call("shopping_list_destinations", {});
  state.destinations = res.destinations || [];
}

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

function describe() {
  var p = current();
  if (p) fab.setContext("The user is viewing the fabplane.com shopping list of fabPlane project \"" + p.name + "\" (project=\"" + p.id + "\"). Use the shopping_list_* tools with that project.", "Shopping list: " + p.name);
}

function select(id) {
  state.project = id; state.list = null; state.signedOut = false;
  $("summary").textContent = "";
  mount($("list"), h("div", { class: "empty" }, "Loading shopping list…"));
  renderProjects();
  describe();
  run("Loading", reload);
}

$("project").addEventListener("change", function (e) { select(e.target.value); });
$("sync").addEventListener("click", sync);
$("open").addEventListener("click", function () { if (state.list && state.list.cartUrl) fab.openLink(state.list.cartUrl).catch(function (e) { setStatus(e.message, "err"); }); });
$("ask").addEventListener("click", function () {
  var p = current(); if (!p) return;
  fab.message("Source everything still marked needed on the shopping list of fabPlane project \"" + p.name + "\" (project=\"" + p.id + "\"): check inventory_search first, pick destinations and fill in SKUs and prices, then summarize by destination.")
    .catch(function (e) { setStatus(e.message, "err"); });
});
$("add").addEventListener("click", function () {
  var text = $("addPart").value.trim(), qty = Number($("addQty").value) || 1;
  if (!text || !state.project) return;
  run("Adding", async function () {
    await fab.call("shopping_list_add", { project: state.project, items: [{ quantity: qty, description: text }] });
    $("addPart").value = "";
    await reload();
  });
});
function searchInventory() {
  var q = $("invQ").value.trim();
  run("Searching inventory", async function () {
    var res = await fab.call("inventory_search", q ? { q: q, limit: 25 } : { limit: 25 });
    var items = res.items || [];
    mount($("inv"), items.length ? h("div", { class: "pad" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Name", "MPN", "On hand", "Location"].map(function (t) { return h("th", {}, t); }))),
      h("tbody", {}, items.map(function (i) {
        return h("tr", {}, h("td", {}, i.name), h("td", { class: "mono small" }, i.mpn || ""), h("td", {}, i.quantity + " " + i.unit), h("td", { class: "small" }, i.location || ""));
      })))) : h("div", { class: "empty" }, "No inventory items match."));
  });
}
$("invGo").addEventListener("click", searchInventory);
$("invQ").addEventListener("keydown", function (e) { if (e.key === "Enter") searchInventory(); });

var toolArgs = {};
fab.on("ui/notifications/tool-input", function (p) { toolArgs = p.arguments || {}; });
fab.on("ui/notifications/tool-result", function (res) {
  if (res.isError) return showError(new Error(fab.textOf(res)));
  var sc = res.structuredContent || {};
  if (sc.projects) state.projects = sc.projects;
  if (sc.list) { state.signedOut = false; state.project = sc.project; state.list = sc.list; renderProjects(); renderList(); describe(); }
  else if (sc.project) select(sc.project);
  if (sc.listError) showError(new Error(sc.listError));
});

fab.connect("fabplane-shopping-list").then(async function () {
  await loadDestinations().catch(showError);
  if (!state.projects.length) state.projects = (await fab.call("projects", {})).projects || [];
  if (state.signedOut) { renderProjects(); controls(); return; }
  if (!state.project && state.projects.length) select(toolArgs.project || state.projects[0].id);
  else { renderProjects(); renderList(); }
}).catch(showError);
controls();
`;

export function shoppingViewHtml(): string {
  return appHtml({ title: "Shopping list", body: BODY, script: SCRIPT });
}
