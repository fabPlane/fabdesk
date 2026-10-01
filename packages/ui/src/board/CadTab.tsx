import { useCallback, useEffect, useState } from "react";
import { FabCadView } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { Button, EmptyState, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

type ViewState =
  | { status: "loading" }
  | { status: "ready"; view: FabCadView }
  | { status: "failed"; error: string };

/** The fab_cad web UI on the project's live FreeCAD session: edits by the agent show up here as they happen. */
export function CadTab() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const [state, setState] = useState<ViewState>({ status: "loading" });

  const load = useCallback(async () => {
    if (!projectId) return;
    setState({ status: "loading" });
    try {
      const res = (await client.callTool("cad_view", { projectId })) as {
        json?: unknown;
        result?: unknown;
      };
      const parsed = FabCadView.safeParse(res.json ?? res.result);
      setState(
        parsed.success
          ? { status: "ready", view: parsed.data }
          : { status: "failed", error: "unexpected cad_view response" },
      );
    } catch (e) {
      setState({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (state.status === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const retry = (
    <Button size="sm" onClick={() => void load()}>
      Retry
    </Button>
  );
  if (state.status === "failed")
    return (
      <EmptyState title="FreeCAD is not available" action={retry}>
        {state.error}
        <div className="mt-2">
          Start the FabPlane CAD bridge with `bun run dev:cad`, or install the FreeCAD backend.
        </div>
      </EmptyState>
    );
  if (!state.view.uiUrl)
    return (
      <EmptyState title="No CAD UI on this bridge" action={retry}>
        The FreeCAD session for this project is running (document {state.view.document}), but the
        bridge at {state.view.bridgeUrl} serves no web UI. Build fab_cad&apos;s apps/web and set
        STATIC_DIR on the bridge.
      </EmptyState>
    );
  return (
    <iframe
      title="FreeCAD"
      src={state.view.uiUrl}
      className="h-full w-full border-0 bg-panel"
      data-testid="cad-frame"
    />
  );
}
