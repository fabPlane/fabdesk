import { useState } from "react";
import { sharedCheckLabel, type ProjectShareSnapshot, type SharedBoard } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import "./project-sharing.css";

export function SharedProjectContent({ snapshot }: { snapshot: ProjectShareSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null);
  const board = snapshot.boards.find((item) => item.id === selected);
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
          <BoardPreview board={board} />
          <p>{sharedCheckLabel(board.checks)}</p>
          <p className="fd-share-muted">
            {board.preview ? "Saved preview · image freshness is unverified. " : ""}PCB checks do
            not establish manufacturing approval.
          </p>
        </>
      ) : (
        <div className="fd-shared-board-list">
          {snapshot.boards.map((item) => (
            <button key={item.id} onClick={() => setSelected(item.id)}>
              <div className="fd-shared-board-thumbnail">
                <BoardPreview board={item} />
              </div>
              <span>
                <strong>{item.name}</strong>
                <small>{sharedCheckLabel(item.checks)}</small>
                {!item.sourceAvailable && <small>Board source unavailable</small>}
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
