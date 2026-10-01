import { FABPLANE_MARK_SVG } from "./brand";

/**
 * Shared shell for fabdesk's MCP App views (`ui://fabdesk/*`, `text/html;profile=mcp-app`).
 * Self-contained HTML: a dependency-free MCP Apps bridge (JSON-RPC over postMessage), host-themed
 * CSS and a tiny DOM builder. Views talk to the server only through `fabdesk_ui_call`.
 */

/** MCP Apps protocol version the views speak (ext-apps `LATEST_PROTOCOL_VERSION`). */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

const CSS = `
:root{
  --bg:var(--color-background-primary,#fff);--bg2:var(--color-background-secondary,#f4f4f5);
  --bg3:var(--color-background-tertiary,#e9e9ec);--fg:var(--color-text-primary,#18181b);
  --fg2:var(--color-text-secondary,#52525b);--fg3:var(--color-text-tertiary,#71717a);
  --line:var(--color-border-primary,#e4e4e7);--accent:#527a31;--on-accent:#fff;--danger:var(--color-text-danger,#b91c1c);
  --ok:var(--color-text-success,#15803d);--warn:var(--color-text-warning,#b45309);
  --font:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);
  --mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);--r:8px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:var(--color-background-primary,#18181b);--bg2:var(--color-background-secondary,#232326);
  --bg3:var(--color-background-tertiary,#2e2e33);--fg:var(--color-text-primary,#fafafa);
  --fg2:var(--color-text-secondary,#b4b4bb);--fg3:var(--color-text-tertiary,#8b8b93);
  --line:var(--color-border-primary,#34343a);--accent:#90bd6b;--on-accent:#102820}}
:root[data-theme=dark]{
  --bg:var(--color-background-primary,#18181b);--bg2:var(--color-background-secondary,#232326);
  --bg3:var(--color-background-tertiary,#2e2e33);--fg:var(--color-text-primary,#fafafa);
  --fg2:var(--color-text-secondary,#b4b4bb);--fg3:var(--color-text-tertiary,#8b8b93);
  --line:var(--color-border-primary,#34343a);--accent:#90bd6b;--on-accent:#102820}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--font)}
body{min-height:100vh}
button,select,input{font:inherit;color:inherit}
button{background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{background:var(--bg3)}button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
select,input{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px}.brand svg{width:26px;height:26px;flex:none;color:var(--accent)}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bar h1{font-size:15px;margin:0 8px 0 0;font-weight:600}
.grow{flex:1}.muted{color:var(--fg3)}.small{font-size:12px}.mono{font-family:var(--mono)}
.err{color:var(--danger)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;background:var(--bg2);border:1px solid var(--line)}
.tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 10px;color:var(--fg2)}
.tabs button[aria-selected=true]{border-bottom-color:var(--accent);color:var(--fg)}
.pad{padding:12px}.empty{padding:32px 16px;text-align:center;color:var(--fg3)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:500;color:var(--fg2);font-size:12px}
.stage{position:relative;overflow:hidden;background:var(--bg2);height:min(70vh,560px);touch-action:none;cursor:grab}
.stage img,.stage .svgwrap{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;user-select:none}
.stage canvas{width:100%;height:100%;display:block}
.hint{position:absolute;right:8px;bottom:6px;font-size:11px;color:var(--fg3);pointer-events:none}
.status{padding:6px 12px;font-size:12px;color:var(--fg2);min-height:24px}
`;

/** Browser-side bridge and helpers, exposed as `fab`. Plain ES2020; no template literals. */
const BRIDGE = String.raw`
const fab = (function () {
  var seq = 0, pending = new Map(), listeners = {}, hostContext = {}, hostCapabilities = {};
  var inFrame = window.parent !== window;
  function post(msg) { msg.jsonrpc = "2.0"; window.parent.postMessage(msg, "*"); }
  function emit(method, params) {
    (listeners[method] || []).forEach(function (h) { try { h(params || {}); } catch (e) { console.error(e); } });
  }
  function applyTheme() {
    var vars = (hostContext.styles && hostContext.styles.variables) || {};
    Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
    if (hostContext.theme) document.documentElement.dataset.theme = hostContext.theme;
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "request failed")); else p.resolve(m.result || {});
      return;
    }
    // Host requests (ping, ui/resource-teardown) need an answer; views keep no unsaved state.
    if (m.id !== undefined) post({ id: m.id, result: {} });
    if (m.method === "ui/notifications/host-context-changed") { Object.assign(hostContext, m.params || {}); applyTheme(); }
    emit(m.method, m.params);
  });
  function request(method, params) {
    if (!inFrame) return Promise.reject(new Error("Open this view from an MCP Apps host (ChatGPT, Codex, Claude)."));
    var id = ++seq;
    return new Promise(function (resolve, reject) { pending.set(id, { resolve: resolve, reject: reject }); post({ id: id, method: method, params: params || {} }); });
  }
  function notify(method, params) { if (inFrame) post({ method: method, params: params || {} }); }
  function textOf(res) {
    return ((res && res.content) || []).filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n");
  }
  return {
    inFrame: inFrame,
    on: function (method, h) { (listeners[method] = listeners[method] || []).push(h); },
    request: request,
    notify: notify,
    textOf: textOf,
    context: function () { return hostContext; },
    capabilities: function () { return hostCapabilities; },
    connect: function (name) {
      return request("ui/initialize", {
        appInfo: { name: name, version: "1.0.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}"
      }).then(function (r) {
        hostContext = r.hostContext || {};
        hostCapabilities = r.hostCapabilities || {};
        applyTheme();
        notify("ui/notifications/initialized", {});
        if (window.ResizeObserver) new ResizeObserver(function () {
          notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
        }).observe(document.body);
        return r;
      });
    },
    /** Run a fabdesk operation through the app-only dispatcher tool; resolves to structuredContent. */
    call: function (name, args) {
      return request("tools/call", { name: "fabdesk_ui_call", arguments: { name: name, arguments: args || {} } }).then(function (res) {
        if (res.isError) throw new Error(textOf(res) || "operation failed");
        return res.structuredContent || {};
      });
    },
    message: function (text, newThread) {
      var params = { role: "user", content: [{ type: "text", text: text }] };
      if (newThread) params._meta = { "openai/message": { target: "new" } };
      return request("ui/message", params);
    },
    setContext: function (text, title) {
      var block = { type: "text", text: text };
      if (title) block._meta = { "openai/title": title };
      return request("ui/update-model-context", { content: [block] }).catch(function () {});
    },
    openLink: function (url) { return request("ui/open-link", { url: url }); },
    fullscreen: function () { return request("ui/request-display-mode", { mode: "fullscreen" }).catch(function () {}); },
    deepLink: function () { var d = hostContext["openai/deepLink"]; return d && d.url ? d.url : null; }
  };
})();

/** DOM builder: h("div", { class: "x", onclick: fn }, "text", child). Strings are text, never HTML. */
function h(tag, attrs) {
  var el = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    var v = attrs[k];
    if (v === undefined || v === null || v === false) return;
    if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  });
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    (Array.isArray(c) ? c : [c]).forEach(function (x) {
      if (x === undefined || x === null || x === false) return;
      el.appendChild(typeof x === "string" || typeof x === "number" ? document.createTextNode(String(x)) : x);
    });
  }
  return el;
}
function mount(node, child) { node.replaceChildren(child); }

/** Pan (drag) and zoom (wheel / pinch / buttons) for an absolutely positioned element in a .stage. */
function panZoom(stage, el) {
  var s = 1, x = 0, y = 0, drag = null, pts = new Map(), pinch = null;
  function apply() { el.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")"; }
  function zoomAt(f, cx, cy) { var ns = Math.min(40, Math.max(0.05, s * f)); x = cx - (cx - x) * (ns / s); y = cy - (cy - y) * (ns / s); s = ns; apply(); }
  function fit() {
    var w = el.naturalWidth || el.scrollWidth || 1, hh = el.naturalHeight || el.scrollHeight || 1;
    s = Math.min(stage.clientWidth / w, stage.clientHeight / hh) * 0.95;
    x = (stage.clientWidth - w * s) / 2; y = (stage.clientHeight - hh * s) / 2; apply();
  }
  stage.addEventListener("wheel", function (e) { e.preventDefault(); var r = stage.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  stage.addEventListener("pointerdown", function (e) { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = [e.clientX - x, e.clientY - y]; });
  stage.addEventListener("pointermove", function (e) {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      var v = Array.from(pts.values()), d = Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]);
      var r = stage.getBoundingClientRect();
      if (pinch) zoomAt(d / pinch, (v[0][0] + v[1][0]) / 2 - r.left, (v[0][1] + v[1][1]) / 2 - r.top);
      pinch = d; return;
    }
    if (drag) { x = e.clientX - drag[0]; y = e.clientY - drag[1]; apply(); }
  });
  function up(e) { pts.delete(e.pointerId); pinch = null; drag = null; }
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("dblclick", fit);
  return { fit: fit, zoom: function (f) { zoomAt(f, stage.clientWidth / 2, stage.clientHeight / 2); } };
}

function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function svgDataUrl(svg) { return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))); }
`;

export function brandHeading(label: string): string {
  return `<h1 class="brand">${FABPLANE_MARK_SVG.replace("<svg ", '<svg aria-hidden="true" ')}<span>fabPlane · ${label}</span></h1>`;
}

export type AppHtmlOptions = {
  title: string;
  /** Static body markup (trusted, authored here). */
  body: string;
  /** View script; runs after the bridge. */
  script: string;
  /** Extra `<head>` markup, e.g. an import map. */
  head?: string;
  /** Load the view script as an ES module (needed for `import`). */
  module?: boolean;
};

export function appHtml(opts: AppHtmlOptions): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${opts.title}</title>`,
    `<style>${CSS}</style>`,
    opts.head ?? "",
    "</head><body>",
    opts.body,
    `<script>${BRIDGE}</script>`,
    `<script${opts.module ? ' type="module"' : ""}>${opts.script}</script>`,
    "</body></html>",
  ].join("\n");
}
