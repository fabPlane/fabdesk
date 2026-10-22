/**
 * Local CAD-tab stand-in for enclosure v2: drives generateEnclosure and serves the preview + exports.
 * Used for manual screenshots; not part of the production desktop bundle.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractBoardFeatures } from "../packages/kicad/src/board-features";
import {
  generateEnclosure,
  meshEnclosure,
  previewEnclosureSvg,
  type EnclosureParams,
} from "../packages/kicad/src/enclosure";

const PORT = Number(process.env["ENCLOSURE_STUDIO_PORT"] ?? 4177);
const OUT = process.env["ENCLOSURE_STUDIO_DIR"] ?? "/tmp/enclosure-v2-studio";

const BOARD = `(kicad_pcb
  (version 20260831)
  (general (thickness 1.6))
  (gr_rect (start 0 0) (end 50 30) (layer "Edge.Cuts"))
  (footprint "MountingHole:MountingHole_2.2mm"
    (layer "F.Cu") (at 4 4)
    (property "Reference" "H1" (at 0 0) (layer "F.SilkS"))
    (pad "" npth circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask")))
  (footprint "MountingHole:MountingHole_2.2mm"
    (layer "F.Cu") (at 46 26)
    (property "Reference" "H2" (at 0 0) (layer "F.SilkS"))
    (pad "" npth circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask")))
  (footprint "Connector_USB:USB_C_Receptacle"
    (layer "F.Cu") (at 25 0)
    (property "Reference" "J1" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -4.5 -3.2) (end 4.5 3.2) (layer "F.CrtYd"))
    (pad "A1" smd rect (at 0 0) (size 0.3 1.5) (layers "F.Cu")))
  (footprint "Connector_Audio:Jack_3.5mm"
    (layer "F.Cu") (at 50 15)
    (property "Reference" "J2" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -3 -3.5) (end 3 3.5) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
)
`;

const features = extractBoardFeatures(BOARD);

function page(): string {
  return `<!doctype html>
<html class="dark" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>fabPlane — Enclosure v2</title>
  <style>
    :root {
      --bg:#191d1a; --panel:#1e231f; --panel2:#2b332c; --border:#343d35;
      --fg:#eef3e9; --muted:#aab8a6; --primary:#addb75; --primary-fg:#101a0a;
      --accent:#addb75;
    }
    * { box-sizing: border-box; }
    body { margin:0; font:13px/1.45 Inter, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
    header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:#131714; border-bottom:1px solid var(--border); }
    header strong { letter-spacing:.08em; text-transform:uppercase; font-size:11px; color:var(--muted); }
    .tabs { display:flex; gap:6px; }
    .tab { padding:4px 10px; border-radius:6px; color:var(--muted); }
    .tab.on { background:var(--panel2); color:var(--fg); }
    main { display:flex; flex-direction:column; min-height:calc(100vh - 46px); }
    section { padding:12px 16px; border-bottom:1px solid var(--border); background:#2b332c66; }
    .row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .grow { flex:1; min-width:200px; }
    .controls { display:grid; grid-template-columns:repeat(6,minmax(110px,1fr)); gap:8px; margin-top:10px; }
    label { display:flex; flex-direction:column; gap:4px; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    input, select { height:32px; border:1px solid var(--border); border-radius:6px; background:#191d1a80; color:var(--fg); padding:0 8px; }
    .check { flex-direction:row; align-items:center; text-transform:none; letter-spacing:0; font-size:13px; color:var(--fg); gap:8px; padding-top:16px; }
    button { height:32px; border:0; border-radius:6px; padding:0 12px; font-weight:600; cursor:pointer; }
    .primary { background:var(--primary); color:var(--primary-fg); }
    .ghost { background:transparent; color:var(--fg); border:1px solid var(--border); }
    .meta { margin:8px 0 0; color:var(--muted); font-size:12px; }
    #preview { margin-top:10px; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:#191d1a; min-height:200px; }
    #preview svg { width:100%; height:auto; display:block; }
    .files { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .files a { color:var(--primary); }
    .cad { flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted); }
  </style>
</head>
<body>
  <header>
    <strong>fabPlane</strong>
    <div class="tabs">
      <span class="tab">Board</span>
      <span class="tab">Schematic</span>
      <span class="tab on">CAD</span>
    </div>
  </header>
  <main>
    <section data-testid="enclosure-panel">
      <div class="row">
        <span style="font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)">Enclosure v2</span>
        <span class="grow" id="summary" data-testid="enclosure-summary">Generate a printable case from the board outline, holes and connectors.</span>
        <button class="primary" id="generate" data-testid="enclosure-generate">Generate</button>
        <button class="ghost" id="check" data-testid="enclosure-check">Check alignment</button>
      </div>
      <div class="controls" data-testid="enclosure-v2-controls">
        <label>Outline offset mm
          <input id="offset" data-testid="enclosure-offset" type="number" min="0" max="40" step="0.5" value="0"/>
        </label>
        <label>Clearance mm
          <input id="clearance" data-testid="enclosure-clearance" type="number" min="0" max="20" step="0.5" value="1"/>
        </label>
        <label>Vent pattern
          <select id="vents" data-testid="enclosure-vents">
            <option value="none">None</option>
            <option value="grid">Grid</option>
            <option value="slots">Slots</option>
            <option value="honeycomb">Honeycomb</option>
          </select>
        </label>
        <label>Vent faces
          <select id="faces" data-testid="enclosure-vent-faces">
            <option value="lid">Lid</option>
            <option value="walls">Walls</option>
            <option value="both">Lid + walls</option>
          </select>
        </label>
        <label class="check"><input id="snap" data-testid="enclosure-snapfit" type="checkbox"/> Snap-fit clips</label>
      </div>
      <p class="meta" id="meta" data-testid="enclosure-meta"></p>
      <div id="preview" data-testid="enclosure-preview"></div>
      <div class="files" id="files"></div>
    </section>
    <div class="cad">FreeCAD bridge optional — STL / STEP / preview write without it.</div>
  </main>
  <script>
    async function generate() {
      const body = {
        outlineOffsetMm: Number(document.getElementById("offset").value),
        clearanceMm: Number(document.getElementById("clearance").value),
        ventPattern: document.getElementById("vents").value,
        ventFaces: document.getElementById("faces").value,
        snapFit: document.getElementById("snap").checked,
      };
      const res = await fetch("/generate", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      document.getElementById("summary").textContent = data.summary;
      document.getElementById("meta").textContent = data.meta;
      document.getElementById("preview").innerHTML = data.previewSvg;
      document.getElementById("files").innerHTML = data.files.map((f) => '<a href="'+f.href+'" download>'+f.label+'</a>').join(" · ");
      document.getElementById("generate").textContent = "Regenerate";
    }
    document.getElementById("generate").onclick = generate;
    document.getElementById("check").onclick = generate;
  </script>
</body>
</html>`;
}

async function generate(input: Partial<EnclosureParams>) {
  const spec = generateEnclosure(features, input);
  const mesh = meshEnclosure(spec);
  const previewSvg = previewEnclosureSvg(spec);
  await mkdir(join(OUT, "exports"), { recursive: true });
  await writeFile(join(OUT, "enclosure.json"), JSON.stringify(spec, null, 2));
  await writeFile(join(OUT, "exports/enclosure.stl"), mesh.baseStl);
  await writeFile(join(OUT, "exports/enclosure-lid.stl"), mesh.lidStl);
  await writeFile(join(OUT, "exports/enclosure.step"), mesh.step);
  await writeFile(join(OUT, "exports/enclosure-preview.svg"), previewSvg);
  const size = `${spec.outer.maxX - spec.outer.minX} × ${spec.outer.maxY - spec.outer.minY} × ${spec.outer.z1} mm`;
  return {
    summary: `Enclosure ${size}, ${spec.standoffs.length} standoff(s), ${spec.cutouts.length} cutout(s); in sync.`,
    meta: `In sync · ${spec.cutouts.length} cutout(s) · ${spec.standoffs.length} hole(s) · ${spec.vents.length} vent(s) · ${spec.clips.length} clip(s) · enclosure.json, exports/enclosure.stl, exports/enclosure-lid.stl, exports/enclosure.step, exports/enclosure-preview.svg`,
    previewSvg,
    files: [
      { href: "/exports/enclosure.stl", label: "exports/enclosure.stl" },
      { href: "/exports/enclosure-lid.stl", label: "exports/enclosure-lid.stl" },
      { href: "/exports/enclosure.step", label: "exports/enclosure.step" },
      { href: "/exports/enclosure-preview.svg", label: "exports/enclosure-preview.svg" },
    ],
    spec,
  };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/generate") {
      const body = (await req.json()) as Partial<EnclosureParams>;
      return Response.json(await generate(body));
    }
    if (url.pathname.startsWith("/exports/")) {
      const file = Bun.file(join(OUT, url.pathname));
      if (await file.exists()) return new Response(file);
      return new Response("missing", { status: 404 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`enclosure v2 studio http://127.0.0.1:${server.port}`);
