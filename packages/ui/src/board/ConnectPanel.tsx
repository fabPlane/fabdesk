import { useMemo, useState } from "react";
import type { BoardFile, BoardPartSummary, PinCheck, ResolvedPartLink } from "@fabdesk/protocol";
import { partPins, pinCheckLabel, rankConnectionTargets, sharedNetLabel, sharedSignalNetCount } from "@fabdesk/client-core";
import { Button, IconButton, Input, Select } from "../components/ui";
import { Icon } from "../components/Icon";

export const LINK_STATE_LABEL: Record<ResolvedPartLink["state"], string> = { current: "Unverified", "needs-review": "Needs review", missing: "Part missing" };
const TARGET_LIMIT = 80;
const partLabel = (part: BoardPartSummary) => [part.value, part.footprint?.split(":").at(-1)?.replaceAll("_", " ")].filter(Boolean).join(" · ");

/** Says where a selected part connects: which board, which part, and which pin goes to which pin. */
export function ConnectPanel({ source, sourceBoard, boards, targetBoard, targetParts, targetLoading, target, link, sourceLinks, pinMap, pinCheck, pinsEdited, activePin, busy, nameOf, onClose, onTargetBoard, onTarget, onOpenLink, onNewTarget, onActivePin, onPin, onSave, onReview, onRemove }: {
  source: BoardPartSummary;
  sourceBoard: string;
  boards: readonly BoardFile[];
  targetBoard: string;
  targetParts: readonly BoardPartSummary[];
  targetLoading: boolean;
  target: BoardPartSummary | null;
  link: ResolvedPartLink | null;
  /** Every saved link touching this part, with the part at its other end. */
  sourceLinks: ReadonlyArray<{ link: ResolvedPartLink; peerRef: string; peerBoard: string }>;
  pinMap: Readonly<Record<string, string>>;
  pinCheck: PinCheck;
  pinsEdited: boolean;
  activePin: string | null;
  busy: boolean;
  nameOf: (path: string) => string;
  onClose: () => void;
  onTargetBoard: (path: string) => void;
  onTarget: (ref: string | null) => void;
  onOpenLink: (link: ResolvedPartLink) => void;
  onNewTarget: () => void;
  onActivePin: (pin: string | null) => void;
  onPin: (pin: string, target: string) => void;
  onSave: () => void;
  onReview: () => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const others = targetParts.filter(part => !(targetBoard === sourceBoard && part.ref === source.ref));
    const matching = needle ? others.filter(part => `${part.ref} ${part.value ?? ""} ${part.footprint ?? ""}`.toLowerCase().includes(needle)) : others;
    return rankConnectionTargets(source, matching);
  }, [query, source, sourceBoard, targetBoard, targetParts]);
  const sourcePins = useMemo(() => partPins(source), [source]);
  const targetPins = useMemo(() => partPins(target), [target]);
  const kindOf = useMemo(() => new Map(pinCheck.rows.map(row => [row.a, row.kind])), [pinCheck]);
  const mapped = Object.values(pinMap).filter(Boolean).length;
  const suggested = !!target && !pinsEdited && !link?.pins?.length && mapped > 0;
  const sharedWith = (part: BoardPartSummary) => sharedSignalNetCount(source, part);

  return <aside className="fd-connect-panel" aria-label={`Connect ${source.ref}`}>
    <header>
      <div>
        <h2>{source.ref}</h2>
        <p title={sourceBoard}>{[partLabel(source), nameOf(sourceBoard)].filter(Boolean).join(" · ")}</p>
      </div>
      <IconButton size="sm" title="Close" onClick={onClose}><Icon name="close" width={16} height={16} /></IconButton>
    </header>

    {sourceLinks.length > 0 && <section aria-label={`${source.ref} connections`}>
      <h3>Connects to</h3>
      {sourceLinks.map(row => <button key={row.link.id} type="button" className="fd-connect-row" aria-pressed={link?.id === row.link.id} data-state={row.link.state} onClick={() => onOpenLink(row.link)}>
        <strong>{row.peerRef}</strong><small>{nameOf(row.peerBoard)}</small><em>{LINK_STATE_LABEL[row.link.state]}</em>
      </button>)}
      {target && <Button size="sm" variant="ghost" onClick={onNewTarget}>Connect to another part</Button>}
    </section>}

    {!target ? <section aria-label="Choose where it connects">
      <h3>{sourceLinks.length ? "Add a connection" : "Connect to"}</h3>
      <label className="fd-connect-field"><span>Board</span>
        <Select aria-label="Target board" value={targetBoard} onChange={event => onTargetBoard(event.target.value)}>
          {boards.map(board => <option key={board.path} value={board.path} title={board.path}>{board.name}</option>)}
        </Select>
      </label>
      <label className="fd-connect-field"><span>Part</span>
        <Input aria-label="Find target part" placeholder="Find a part…" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <p className="fd-connect-hint">Pick one below, or click it on the {targetBoard === sourceBoard ? "board" : "other board"}.</p>
      <div className="fd-connect-targets" role="list" aria-label="Target parts">
        {targetLoading ? <p className="fd-connect-hint">Reading this board…</p> : candidates.length === 0 ? <p className="fd-connect-hint">No parts match.</p> : candidates.slice(0, TARGET_LIMIT).map(part => {
          const shared = sharedWith(part);
          return <button key={part.ref} type="button" role="listitem" className="fd-connect-row" onClick={() => onTarget(part.ref)}>
            <strong>{part.ref}</strong><small>{partLabel(part)}</small>{shared > 0 && <em data-shared>{sharedNetLabel(shared)}</em>}
          </button>;
        })}
        {candidates.length > TARGET_LIMIT && <p className="fd-connect-hint">{candidates.length - TARGET_LIMIT} more. Search to narrow this list.</p>}
      </div>
    </section> : <section aria-label="Pin connections" className="fd-connect-pins">
      <h3>{source.ref} → {target.ref}</h3>
      <p className="fd-connect-target-board">{partLabel(target)} · {nameOf(targetBoard)}{!link && <button type="button" onClick={() => onTarget(null)}>Change</button>}</p>
      {link && <p className="fd-connect-state" data-state={link.state}>{LINK_STATE_LABEL[link.state]}{link.reasons.length ? `: ${link.reasons.join("; ")}` : ""}</p>}
      {sourcePins.length === 0 || targetPins.length === 0
        ? <p className="fd-connect-hint">{sourcePins.length === 0 ? source.ref : target.ref} has no numbered pins, so this links the parts only.</p>
        : <>
          <p className="fd-connect-hint">{suggested ? "Filled in from matching net names. Check each pin before saving." : "Pick a pin here or click its pad, then choose or click the pad it goes to."}</p>
          <div className="fd-connect-pin-table" role="table" aria-label={`Pins from ${source.ref} to ${target.ref}`}>
            {sourcePins.map(pin => {
              const to = pinMap[pin.pin] ?? "";
              const kind = to ? kindOf.get(pin.pin) : undefined;
              return <div key={pin.pin} role="row" className="fd-connect-pin" aria-current={activePin === pin.pin} data-mapped={!!to} data-check={kind}>
                <button type="button" role="cell" aria-pressed={activePin === pin.pin} title={pin.net} onClick={() => onActivePin(activePin === pin.pin ? null : pin.pin)}>
                  <strong>{pin.pin}</strong><small>{pin.net ?? "No net"}</small>
                </button>
                <span aria-hidden="true">→</span>
                <Select role="cell" aria-label={`Pin on ${target.ref} for pin ${pin.pin}`} value={to} onFocus={() => onActivePin(pin.pin)} onChange={event => onPin(pin.pin, event.target.value)}>
                  <option value="">Not connected</option>
                  {targetPins.map(option => <option key={option.pin} value={option.pin}>{option.pin}{option.net ? ` · ${option.net}` : ""}</option>)}
                </Select>
                {kind === "conflict" && <small className="fd-connect-mismatch" data-check="conflict">Different power or ground nets</small>}
                {kind === "differs" && <small className="fd-connect-mismatch">Net names differ</small>}
              </div>;
            })}
          </div>
        </>}
      {targetPins.length > 0 && sourcePins.length > 0 && <p className="fd-connect-check" data-check={pinCheck.status} role="status">{pinCheckLabel(pinCheck)}</p>}
      <div className="fd-connect-actions">
        {(!link || pinsEdited || suggested) && <Button size="sm" variant="primary" disabled={busy} onClick={onSave}>{!link ? "Save connection" : "Save pins"}</Button>}
        {link?.state === "needs-review" && <Button size="sm" variant="secondary" disabled={busy} onClick={onReview}>Mark reviewed</Button>}
        {link && <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>Remove link</Button>}
      </div>
      <p className="fd-connect-note">{mapped} of {sourcePins.length} pins mapped. The check compares net names only, not the actual circuit, so stays unverified.</p>
    </section>}
  </aside>;
}
