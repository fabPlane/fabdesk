import { useState } from "react";
import type { PcbDisplay } from "@fabdesk/client-core";
import { MechanicalScene } from "./MechanicalScene";

export function PcbModelStatus({
  models,
  loading,
  error,
  retry,
}: {
  models: Record<string, PcbDisplay>;
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const entries = Object.entries(models);
  const missing = entries.flatMap(([path, m]) =>
    m.coverage.missing.map((ref) => `${path}: ${ref}`),
  );
  const warnings = entries.flatMap(([, m]) => m.warnings);
  const barePad = (name: string) => /(?:^|:)TestPoint_Pad_|SolderJumper/i.test(name);
  const priority = (reason: string, footprint: string) =>
    reason !== "unassigned" ? 0 : barePad(footprint) ? 2 : 1;
  const repair = {
    unassigned: "Assign a model in the PCB footprint, then refresh.",
    hidden: "Enable the footprint's 3D model in KiCad, then refresh.",
    "not-loaded":
      "Check the model file and KiCad library path, then refresh. A linked filename alone does not supply geometry.",
    partial:
      "Some linked models did not load. Check every model file in this footprint, then refresh.",
  };
  async function download(path: string, model: PcbDisplay) {
    setExporting(true);
    setExportError("");
    try {
      const blob = await MechanicalScene.boardStl(model.modelPath, model.data);
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = path
        .split("/")
        .at(-1)!
        .replace(/\.kicad_pcb$/i, model.coverage.missing.length ? "-partial.stl" : ".stl");
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }
  const downloads = entries.map(([path, model]) => (
    <button key={path} disabled={loading || exporting} onClick={() => void download(path, model)}>
      Download {entries.length > 1 ? path.split("/").at(-1) : "PCB"} STL
      {model.coverage.missing.length ? " (partial)" : ""}
    </button>
  ));
  return (
    <section className="fd-pcb-model-status" aria-label="PCB model quality">
      <div>
        <strong>
          {loading
            ? "Loading PCB geometry…"
            : error
              ? "PCB model needs attention"
              : "KiCad 3D geometry"}
        </strong>
        <button disabled={loading || exporting} onClick={retry}>
          Refresh
        </button>
      </div>
      <p>
        {loading
          ? "Reading board geometry. Already loaded boards stay visible."
          : !entries.length
            ? "The detailed model is unavailable. Resolve the issue below, then refresh."
            : entries.every(([, m]) => m.coverage.total === 0)
              ? "Board geometry loaded · no component bodies required"
              : `${entries.reduce((n, [, m]) => n + m.coverage.loaded, 0)} / ${entries.reduce((n, [, m]) => n + m.coverage.total, 0)} component models loaded · dimensions in mm`}
      </p>
      {!!missing.length && (
        <details>
          <summary>{missing.length} footprints need model review</summary>
          <p>
            Assign their 3D models in the PCB design, then refresh. Missing parts are not drawn.
          </p>
          <div className="fd-pcb-model-gaps">
            {entries
              .filter(([, m]) => m.coverage.missing.length)
              .map(([path, m]) => (
                <div key={path}>
                  <strong>{path.split(/[\\/]/).at(-1)}</strong>
                  {m.coverage.details?.length ? (
                    [...m.coverage.details]
                      .sort(
                        (a, b) => priority(a.reason, a.footprint) - priority(b.reason, b.footprint),
                      )
                      .map((gap, index) => (
                        <article key={`${gap.ref}-${index}`}>
                          <strong>{gap.ref}</strong>
                          <small>{gap.footprint}</small>
                          <p>
                            {gap.reason === "unassigned" && barePad(gap.footprint)
                              ? "No separate body is assigned to this pad. Check solder height and probe or jumper access."
                              : repair[gap.reason]}
                          </p>
                          {!!gap.models.length && (
                            <details>
                              <summary>Linked files</summary>
                              {gap.models.map((file, i) => (
                                <code key={i}>{file}</code>
                              ))}
                            </details>
                          )}
                        </article>
                      ))
                  ) : (
                    <p>{m.coverage.missing.join(", ")}</p>
                  )}
                </div>
              ))}
          </div>
        </details>
      )}
      {!!warnings.length && (
        <details>
          <summary>KiCad export notes</summary>
          <p>{warnings.join("\n")}</p>
        </details>
      )}
      {error && (
        <>
          <details>
            <summary>Why a detailed model is unavailable</summary>
            <p role="alert">{error}</p>
          </details>
          <small>
            Loaded models stay visible if a refresh fails. Boards without a model appear as amber
            bounds in Enclosure; these are estimated references, not detailed geometry.
          </small>
        </>
      )}
      {exportError && <p role="alert">{exportError}</p>}
      {entries.length > 1 ? (
        <details>
          <summary>PCB STL downloads · {entries.length} boards</summary>
          {downloads}
        </details>
      ) : (
        downloads
      )}
      {!!entries.length && (
        <small>
          STL includes the loaded geometry. Bounds-based fit checks cannot verify exact component
          collisions.
        </small>
      )}
    </section>
  );
}
