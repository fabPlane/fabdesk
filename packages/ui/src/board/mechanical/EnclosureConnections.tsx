import { useState } from "react";
import { cableAssessments, type MechanicalDesign } from "@fabdesk/protocol";
import { enclosureFileLabel, type EnclosureBoardSummary } from "@fabdesk/client-core";
import { NumberField } from "./EnclosureNumberField";
import "./enclosure-connections.css";

type Board = { placement: MechanicalDesign["boards"][number]; features: EnclosureBoardSummary };
type Connection = NonNullable<MechanicalDesign["connections"]>[number];
type Endpoint = Connection["from"];
const samePort = (a: Endpoint, b: Endpoint) => a.boardPath === b.boardPath && a.ref === b.ref;
const boardName = (path: string) => enclosureFileLabel(path).replace(/\.kicad_pcb$/i, "");

export function enclosureConnectionError(
  design: MechanicalDesign,
  boards: Board[],
  from: Endpoint,
  to: Endpoint,
  length: number,
  slack: number,
): string | null {
  if (!from.boardPath || !from.ref || !to.boardPath || !to.ref) return "Choose both ports.";
  const exists = (p: Endpoint) =>
    design.boards.some((b) => b.path === p.boardPath) &&
    boards.some(
      (b) =>
        b.placement.path === p.boardPath && b.features.connectors?.some((c) => c.ref === p.ref),
    );
  if (!exists(from) || !exists(to)) return "A selected port is unavailable. Choose it again.";
  if (samePort(from, to)) return "Choose two different ports.";
  if ((design.connections?.length ?? 0) >= 100) return "This case already has 100 connections.";
  if (
    design.connections?.some(
      (c) =>
        (samePort(c.from, from) && samePort(c.to, to)) ||
        (samePort(c.from, to) && samePort(c.to, from)),
    )
  )
    return "These ports are already connected.";
  if (!Number.isFinite(length) || length <= 0 || length > 2000)
    return "Cable length must be between 0 and 2,000 mm.";
  if (!Number.isFinite(slack) || slack < 0 || slack > 1000 || slack >= length)
    return "Extra room must be smaller than the cable length.";
  return null;
}

/** Explicit user-defined mechanical cable links; this does not infer electrical connectivity. */
export function EnclosureConnections({
  design,
  boards,
  onChange,
  onClose,
  disabled = false,
}: {
  design: MechanicalDesign;
  boards: Board[];
  onChange: (design: MechanicalDesign) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [from, setFrom] = useState<Endpoint>({ boardPath: "", ref: "" });
  const [to, setTo] = useState<Endpoint>({ boardPath: "", ref: "" });
  const [length, setLength] = useState(100);
  const [slack, setSlack] = useState(10);
  const selectedBoards = boards.filter((b) =>
    design.boards.some((p) => p.path === b.placement.path),
  );
  const available = selectedBoards.filter((b) => b.features.connectors?.length);
  const assessments = cableAssessments(design, selectedBoards);
  const error = enclosureConnectionError(design, selectedBoards, from, to, length, slack);
  const complete = !!from.ref && !!to.ref;
  const draft =
    complete && !error
      ? cableAssessments(
          { ...design, connections: [{ id: "draft", from, to, length, slack }] },
          selectedBoards,
        )[0]
      : null;
  const endpoint = (label: string, value: Endpoint, update: (next: Endpoint) => void) => {
    const ports =
      available.find((b) => b.placement.path === value.boardPath)?.features.connectors ?? [];
    return (
      <div className="fd-enclosure-connection-endpoint">
        <span>{label}</span>
        <label>
          <span className="fd-enclosure-connections-sr">{label} board</span>
          <select
            aria-label={`${label} board`}
            value={value.boardPath}
            onChange={(e) => update({ boardPath: e.target.value, ref: "" })}
          >
            <option value="">Choose board…</option>
            {available.map((b) => (
              <option key={b.placement.path} value={b.placement.path}>
                {boardName(b.placement.path)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="fd-enclosure-connections-sr">{label} port</span>
          <select
            aria-label={`${label} port`}
            value={value.ref}
            disabled={disabled || !value.boardPath}
            onChange={(e) => update({ ...value, ref: e.target.value })}
          >
            <option value="">Choose port…</option>
            {ports.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.ref}
                {c.footprint ? ` · ${c.footprint.split(":").at(-1)!.replaceAll("_", " ")}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  };
  return (
    <aside className="fd-enclosure-connections" aria-label="Board connections">
      <header>
        <div>
          <h2>Connections</h2>
          <p>Choose the ports your cable joins.</p>
        </div>
        <button type="button" aria-label="Close connections" onClick={onClose}>
          ×
        </button>
      </header>
      <fieldset disabled={disabled}>
        {!!assessments.length && (
          <ul className="fd-enclosure-connection-list">
            {assessments.map((c) => (
              <li key={c.id}>
                <div className="fd-enclosure-connection-heading">
                  <strong>
                    {c.from.ref} <span aria-hidden="true">→</span> {c.to.ref}
                  </strong>
                  <button
                    type="button"
                    aria-label={`Remove ${c.from.ref} to ${c.to.ref} connection`}
                    onClick={() =>
                      onChange({
                        ...design,
                        connections: design.connections!.filter((item) => item.id !== c.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <small title={`${c.from.boardPath} → ${c.to.boardPath}`}>
                  {boardName(c.from.boardPath)} → {boardName(c.to.boardPath)}
                </small>
                <p
                  className="fd-enclosure-connection-check"
                  data-warning={c.distance === null || !c.reachable}
                >
                  {c.distance === null
                    ? "A port is unavailable. Remove this link or restore the board."
                    : !c.reachable
                      ? `Cable too short: at least ${Math.ceil(c.required!)} mm including extra room.`
                      : `${Number(c.distance.toFixed(1))} mm between ports · ${c.length} mm cable`}
                </p>
                <details>
                  <summary>Cable options</summary>
                  <NumberField
                    label="Cable length"
                    inputLabel={`Cable length for ${c.from.ref} to ${c.to.ref}`}
                    value={c.length}
                    min={0.1}
                    max={2000}
                    onChange={(value) =>
                      onChange({
                        ...design,
                        connections: design.connections!.map((item) =>
                          item.id === c.id ? { ...item, length: value } : item,
                        ),
                      })
                    }
                  />
                  <NumberField
                    label="Extra room"
                    inputLabel={`Extra cable room for ${c.from.ref} to ${c.to.ref}`}
                    value={c.slack}
                    min={0}
                    max={1000}
                    onChange={(value) =>
                      onChange({
                        ...design,
                        connections: design.connections!.map((item) =>
                          item.id === c.id ? { ...item, slack: value } : item,
                        ),
                      })
                    }
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
        {!available.length ? (
          <p className="fd-enclosure-connections-empty">
            Choose boards with readable connector references to add a cable.
          </p>
        ) : (
          <>
            {endpoint("From", from, setFrom)}
            {endpoint("To", to, setTo)}
            <details className="fd-enclosure-connection-options">
              <summary>Cable options</summary>
              <NumberField
                label="Cable length"
                value={length}
                min={0.1}
                max={2000}
                onChange={setLength}
              />
              <NumberField
                label="Extra room"
                value={slack}
                min={0}
                max={1000}
                onChange={setSlack}
              />
              <small>Extra room allows for bends and plugging in.</small>
            </details>
            <p className="fd-enclosure-connections-note">
              {length} mm cable · {slack} mm extra room. Starting estimates; adjust for your cable.
            </p>
            {complete && error && (
              <p className="fd-enclosure-connection-error" role="alert">
                {error}
              </p>
            )}
            {draft?.distance !== null && draft?.distance !== undefined && (
              <p className="fd-enclosure-connection-check" data-warning={!draft.reachable}>
                {Number(draft.distance.toFixed(1))} mm between ports
                {!draft.reachable
                  ? ` · needs at least ${Math.ceil(draft.required!)} mm of cable`
                  : ""}
              </p>
            )}
            <button
              type="button"
              className="fd-mechanical-primary fd-enclosure-connection-add"
              disabled={!!error}
              onClick={() => {
                if (
                  disabled ||
                  enclosureConnectionError(design, selectedBoards, from, to, length, slack)
                )
                  return;
                onChange({
                  ...design,
                  connections: [
                    ...(design.connections ?? []),
                    { id: crypto.randomUUID(), from, to, length, slack },
                  ],
                });
                setFrom({ boardPath: "", ref: "" });
                setTo({ boardPath: "", ref: "" });
              }}
            >
              Add connection
            </button>
          </>
        )}
      </fieldset>
      <footer>
        Guides show port spacing. Check matching plugs and the cable path before making the case.
      </footer>
    </aside>
  );
}
