import type { WorkspaceContext } from "@fabdesk/protocol";
import { useUiStore } from "./stores/ui";

/** Adapted from the previous panel work. Loaded hidden content is not a display receipt. */
export function panelVisible(stage: HTMLElement | null): boolean {
  if (
    !stage ||
    stage.closest('[inert],[aria-hidden="true"],[hidden]') ||
    document.querySelector('[role="dialog"][aria-modal="true"]')
  )
    return false;
  for (let node: HTMLElement | null = stage; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return false;
  }
  const r = stage.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < innerHeight &&
    r.left < innerWidth
  );
}
export function capturePanelContext() {
  const ui = useUiStore.getState();
  const stage = document.querySelector<HTMLElement>('[data-testid="board-panel"]');
  const parent = stage?.querySelector<HTMLElement>("[data-workspace-artifact]");
  const image = parent?.querySelector<HTMLElement>("[data-workspace-artifact]");
  const detail =
    image?.dataset.workspaceArtifact === parent?.dataset.workspaceArtifact ? image : parent;
  let sourceFreshness: unknown = { status: "unknown" };
  try {
    sourceFreshness = JSON.parse(parent?.dataset.workspaceFreshness ?? "null") ?? sourceFreshness;
  } catch {
    /* Unknown receipt. */
  }
  const freshness = sourceFreshness as { artifactSha256?: string; checkedAt?: string };
  const age = freshness.checkedAt ? Date.now() - Date.parse(freshness.checkedAt) : NaN;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    freshness.artifactSha256 !== detail?.dataset.workspaceSha256 ||
    !freshness.checkedAt ||
    age > 5000
  )
    sourceFreshness = { status: "unknown" };
  return {
    projectId: ui.activeProjectId,
    threadId: ui.activeThreadId,
    capturedAt: new Date().toISOString(),
    panel: {
      visible:
        ui.boardOpen &&
        !ui.settingsOpen &&
        !ui.sketchOpen &&
        !ui.inventoryOpen &&
        !ui.orderFlowOpen &&
        panelVisible(stage ?? null),
      tab: ui.boardTab,
      artifact: detail?.dataset.workspaceArtifact ?? null,
      artifactSha256: detail?.dataset.workspaceSha256 ?? null,
      status: detail?.dataset.workspaceStatus ?? "unknown",
      sourceFreshness,
    },
  };
}
export function attachPanelContext(context: WorkspaceContext): WorkspaceContext {
  const details = JSON.parse(context.details);
  const encoded = JSON.stringify({ ...details, panelObservation: capturePanelContext() });
  return encoded.length <= 16000 ? { ...context, details: encoded } : context;
}
