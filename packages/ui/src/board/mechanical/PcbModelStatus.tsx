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
          ? "Reading the board and its linked component models."
          : !entries.length
            ? "The detailed model is unavailable. Resolve the issue below, then refresh."
            : entries.every(([, m]) => m.coverage.total === 0)
              ? "Board geometry loaded · no component bodies required"
              : `${entries.reduce((n, [, m]) => n + m.coverage.loaded, 0)} / ${entries.reduce((n, [, m]) => n + m.coverage.total, 0)} component models loaded · dimensions in mm`}
      </p>
      {!!missing.length && (
        <details>
          <summary>{missing.length} components missing 3D geometry</summary>
          <p>
            Assign their 3D models in the PCB design, then refresh. Missing parts are not drawn.
          </p>
          <p>{missing.join(", ")}</p>
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
            Unavailable boards remain visible as amber bounds in Enclosure. These are estimated
            references, not detailed models.
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
          STL includes the loaded geometry. Fit checks still use estimated component bounds.
        </small>
      )}
    </section>
  );
}
