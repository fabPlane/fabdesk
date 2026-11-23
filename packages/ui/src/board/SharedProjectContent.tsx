import { lazy, Suspense, useMemo, useState } from "react";
import { sharedCheckLabel, sharedModelLabel, sharedSourceLabel, type ProjectShareSnapshot, type SharedBoard } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import "./project-sharing.css";

const ModelCanvas = lazy(() => import("./ModelCanvas"));

export function SharedProjectContent({ snapshot }: { snapshot: ProjectShareSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null);
  const board = snapshot.boards.find((item) => item.id === selected);
  const [view, setView] = useState<"pcb" | "3d">("pcb");
  const model = useMemo(
    () =>
      board?.model
        ? new Blob([Uint8Array.from(atob(board.model.dataBase64), (char) => char.charCodeAt(0))], {
            type: "model/gltf-binary",
          })
        : undefined,
    [board?.model?.dataBase64],
  );
  return (
    <section className="fd-shared-content">
      <header>
        <h2>{snapshot.name}</h2>
        <p>
          {snapshot.boards.length} {snapshot.boards.length === 1 ? "board" : "boards"} · Read-only
        </p>
      </header>
      {board ? (
        <>
          <div className="fd-shared-board-nav">
            <Button size="sm" onClick={() => setSelected(null)}>
              <Icon name="chevronLeft" width={16} height={16} />
              All boards
            </Button>
            <label>
              Board
              <select value={board.id} onChange={(event) => setSelected(event.target.value)}>
                {snapshot.boards.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <h3>{board.name}</h3>
          <div role="tablist" aria-label="Shared board views" className="fd-shared-view-tabs">
            <Button aria-selected={view === "pcb"} role="tab" onClick={() => setView("pcb")}>
              PCB
            </Button>
            <Button aria-selected={view === "3d"} role="tab" onClick={() => setView("3d")}>
              3D
            </Button>
          </div>
          {view === "pcb" ? (
            <BoardPreview board={board} />
          ) : model ? (
            <div className="fd-shared-model">
              <Suspense fallback={<p>Opening 3D model…</p>}>
                <ModelCanvas projectId="" path="published-board.glb" blob={model} />
              </Suspense>
            </div>
          ) : (
            <div className="fd-shared-no-preview">
              <span>No published 3D model</span>
              <span>Export a model in desktop and update the shared page.</span>
            </div>
          )}
          <p>{sharedCheckLabel(board.checks)} · {sharedModelLabel(board)}</p>
          <p className="fd-share-muted">
            {board.preview ? "Saved preview · image freshness is unverified. " : ""}PCB checks do
            not establish manufacturing approval.
          </p>
        </>
      ) : (
        <div className="fd-shared-board-list">
          {snapshot.library && snapshot.library.length > 0 && (
            <div className="fd-shared-library">
              <h3>Project files</h3>
              <p className="fd-share-muted">
                Datasheets and notes published with this board. Visibility follows the share settings.
              </p>
              <ul>
                {snapshot.library.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <small>
                      {item.kind.replaceAll("_", " ")}
                      {item.pageCount ? ` · ${item.pageCount} pages` : ""}
                      {item.linkedRefs.length ? ` · ${item.linkedRefs.join(", ")}` : ""}
                    </small>
                    {item.textExcerpt && <p>{item.textExcerpt}</p>}
                    {item.preview && (
                      <img
                        src={`data:${item.preview.contentType};base64,${item.preview.dataBase64}`}
                        alt=""
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {snapshot.boards.map((item) => (
            <button key={item.id} onClick={() => setSelected(item.id)}>
              <div className="fd-shared-board-thumbnail">
                <BoardPreview board={item} />
              </div>
              <span>
                <strong>{item.name}</strong>
                <small>{sharedSourceLabel(item)}</small>
                <small>Saved PCB checks · {sharedCheckLabel(item.checks)}</small>
                <small>Saved 3D · {sharedModelLabel(item)}</small>
              </span>
              <Icon name="chevronRight" width={18} height={18} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
function BoardPreview({ board }: { board: SharedBoard }) {
  return board.preview ? (
    <img
      src={`data:image/png;base64,${board.preview.dataBase64}`}
      alt={`Saved PCB preview of ${board.name}`}
    />
  ) : (
    <div className="fd-shared-no-preview">
      <Icon name="pcb" width={28} height={28} />
      <span>No saved preview</span>
    </div>
  );
}
