import { useState } from "react";
import { enclosureFileLabel } from "@fabdesk/client-core";
import { MechanicalIcon } from "./MechanicalIcon";

export function EnclosureBoardPicker({
  files,
  selected,
  onChange,
}: {
  files: string[];
  selected: string[];
  onChange: (paths: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = files.filter((p) => p.toLowerCase().includes(search.toLowerCase()));
  return (
    <section
      className="fd-case-board-picker"
      aria-label="Choose boards"
      data-enclosure-control="boards"
    >
      <div className="fd-case-intro">
        <h3>What goes inside?</h3>
        <p>Choose the boards for this case. We’ll read their sizes for you.</p>
      </div>
      <div className="fd-case-picker-toolbar">
        <strong>{selected.length} selected</strong>
        {!!files.length && (
          <button
            type="button"
            onClick={() =>
              onChange(files.length > 20 || selected.length === files.length ? [] : files)
            }
          >
            {files.length > 20 || selected.length === files.length
              ? "Clear selection"
              : "Select all"}
          </button>
        )}
      </div>
      {files.length > 6 && (
        <input
          type="search"
          aria-label="Find a board"
          placeholder="Find a board…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="fd-case-board-list">
        {shown.map((path) => (
          <label key={path} className="fd-case-board-option" title={path}>
            <input
              type="checkbox"
              checked={selected.includes(path)}
              disabled={selected.length >= 20 && !selected.includes(path)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, path] : selected.filter((p) => p !== path),
                )
              }
            />
            <MechanicalIcon name="cube" />
            <span>
              <strong>{enclosureFileLabel(path).replace(/\.kicad_pcb$/i, "")}</strong>
              <small>
                {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Project board"}
              </small>
            </span>
          </label>
        ))}
      </div>
      {files.length > 20 && <p className="fd-case-hint">Choose up to 20 boards for one case.</p>}
      {!files.length && (
        <p className="fd-case-empty">
          Add a KiCad board to this project, then reopen Enclosure to choose it here.
        </p>
      )}
      {!!files.length && !shown.length && <p>No boards match. Try a shorter name.</p>}
      {!!files.length && !selected.length && (
        <p className="fd-case-hint">Select a board to continue.</p>
      )}
    </section>
  );
}
