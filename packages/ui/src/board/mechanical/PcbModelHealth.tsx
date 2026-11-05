import type { PcbDisplay, PcbModelReadiness } from "@fabdesk/client-core";
import { useUiStore } from "../../stores/ui";
import { MechanicalIcon } from "./MechanicalIcon";

export function PcbModelHealth({
  models,
  loading,
  error,
  retry,
  readiness,
  setupError,
  fixing,
  fixSetup,
  requested,
}: {
  models: Record<string, PcbDisplay>;
  loading: boolean;
  error: string;
  retry: () => void;
  readiness: PcbModelReadiness | null;
  setupError: string;
  fixing: boolean;
  fixSetup: () => Promise<void>;
  requested: number;
}) {
  const loaded = Object.keys(models).length;
  const unavailable = Math.max(0, requested - loaded);
  const needsSetup = readiness?.needsSetup;
  const problem = !loading && (unavailable > 0 || !!error);
  if (!requested) return null;
  if (!loading && !problem && !needsSetup && !setupError)
    return (
      <p className="fd-model-health-ready" role="status">
        <MechanicalIcon name="cube" />
        {loaded} boards visible
      </p>
    );
  return (
    <section
      className={`fd-model-health${problem || needsSetup ? " needs-attention" : ""}`}
      aria-label="Board loading status"
      aria-live="polite"
    >
      <div>
        <MechanicalIcon name="cube" />
        <strong>
          {loading
            ? `Loading boards · ${loaded} of ${requested}`
            : unavailable
              ? `${unavailable} board${unavailable === 1 ? "" : "s"} need a 3D model`
              : `${loaded} board${loaded === 1 ? "" : "s"} visible`}
        </strong>
      </div>
      {loading && <p>Loaded boards stay visible while the others load.</p>}
      {problem && (
        <p>
          {unavailable
            ? "Amber outlines show where missing boards belong. They are not detailed models."
            : "Refresh did not finish. Your unchanged boards are still visible."}
        </p>
      )}
      {needsSetup && (
        <p>
          {readiness.exporter
            ? `Some boards were saved with a newer KiCad than ${readiness.exporter.version}. A newer exporter may be needed.`
            : "A working KiCad exporter is needed to display your boards."}
        </p>
      )}
      {(problem || needsSetup) && (
        <div className="fd-model-health-actions">
          {readiness?.suggested ? (
            <button disabled={loading || fixing} onClick={() => void fixSetup()}>
              {fixing ? "Updating setup…" : `Use KiCad ${readiness.suggested.version} & retry`}
            </button>
          ) : (
            <button onClick={() => useUiStore.getState().setSettingsOpen(true, "kicad")}>
              Fix setup
            </button>
          )}
          <button disabled={loading || fixing} onClick={retry}>
            Retry loading
          </button>
        </div>
      )}
      {readiness?.suggested && (
        <small>Uses the installed exporter for this app. PCB files stay unchanged.</small>
      )}
      {setupError && (
        <details>
          <summary>Setup check unavailable</summary>
          <p>{setupError}</p>
          <button disabled={loading} onClick={retry}>
            Check again
          </button>
        </details>
      )}
    </section>
  );
}
