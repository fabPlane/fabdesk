import { ErrorNotice } from "../components/ErrorNotice";
import { useState } from "react";
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Button, LoadError, Spinner } from "../components/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { useUiStore } from "../stores/ui";
import { useOutputSource } from "./useOutputSource";

/** An intentional image export from the selected saved PCB, using the existing native renderer. */
export function BoardImageOutput({ projectId }: { projectId: string }) {
  const scope = useOutputSource(projectId), project = useProject(projectId), tool = useRunTool();
  const [view, setView] = useState<"top" | "bottom" | "perspective" | "side">("top");
  const busy = tool.state.status === "running", path = `${scope.prefix}renders/${view}.png`;
  const present = project.data?.files.some(file => file.path === path);
  const ready = scope.ready && !!project.data?.files.some(file => file.path === `${scope.prefix}board.kicad_pcb`);
  const render = async () => {
    if (!ready || busy || useUiStore.getState().activeProjectId !== projectId) return;
    const result = await tool.run("render_board", { projectId, view, ...(scope.board ? { board: scope.board, expectedSourceSha256: scope.row?.pcbSha256 } : {}) });
    if (result.status === "done") await project.refetch();
  };
  return <div className="fd-image-output">
    <p>Create an image from a saved PCB. Missing component models may affect its appearance.</p>
    {scope.assembly && <label>Board source<select aria-label="Board source for image" disabled={busy || scope.sources.isFetching} value={scope.sourceId ?? ""} onChange={event => scope.choose(event.target.value)}><option value="" disabled>Choose a board…</option>{!scope.row && scope.sourceId && <option value={scope.sourceId} disabled>Source definition changed</option>}{scope.data?.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · unavailable" : ""}</option>)}</select></label>}
    <div className="fd-image-output-views" role="group" aria-label="Image view">{(["top", "bottom", "perspective", "side"] as const).map(item => <Button key={item} size="sm" disabled={busy} aria-pressed={item === view} onClick={() => setView(item)}>{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</div>
    {scope.sources.isError ? <LoadError title="Could not check board sources" onRetry={() => void scope.sources.refetch()} /> : <>
      {present ? <><ProjectImage retryable projectId={projectId} path={path} alt={`${view} board image`} /><p>Saved image · Source and component-model dependencies unverified</p></> : <div className="fd-image-output-placeholder">{scope.sources.isFetching ? <Spinner /> : ready ? "Choose a view, then render the image." : "Select an available board with a saved KiCad PCB."}</div>}
      {scope.assembly && !scope.ready && scope.row?.status === "available" && <Button disabled={busy} onClick={() => scope.sourceId && scope.choose(scope.sourceId)}>Select source again</Button>}
      <div className="fd-image-output-actions"><span>{scope.prefix}renders/{view}.png</span><Button variant="primary" disabled={!ready || busy} onClick={() => void render()}>{busy ? <><Spinner />Rendering…</> : present ? "Update image" : "Render image"}</Button>{present && <Button onClick={() => useUiStore.getState().openProjectFile(path)}>Open saved file</Button>}</div>
      {tool.state.error && <ErrorNotice error={tool.state.error} />}
    </>}
  </div>;
}
