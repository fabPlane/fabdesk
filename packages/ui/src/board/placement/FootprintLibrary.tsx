import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPlacementLibrary,
  replacementPreview,
  parse,
  partFromNode,
  type PlacementPart,
  type Point,
} from "@fabdesk/client-core/placement";
import { Dialog, Button } from "../../components/ui";

export type FootprintChoice = { name: string; title: string; text: string; part: PlacementPart };
const path = (loops: Point[][]) =>
  loops.map((l) => l.map((p, i) => `${i ? "L" : "M"}${p.join(" ")}`).join(" ") + "Z").join(" ");
const fmt = (n: number) => Number(n.toFixed(2));
export function FootprintPicture({
  part,
  previous,
}: {
  part: PlacementPart;
  previous?: PlacementPart;
}) {
  const boxes = [part.bounds, ...(previous ? [previous.bounds] : [])],
    x = Math.min(...boxes.map((b) => b.minX)) - 1,
    y = Math.min(...boxes.map((b) => b.minY)) - 1;
  const w = Math.max(...boxes.map((b) => b.maxX)) - x + 1,
    h = Math.max(...boxes.map((b) => b.maxY)) - y + 1;
  return (
    <svg
      viewBox={`${x} ${y} ${w} ${h}`}
      aria-label={previous ? "Current and replacement footprint overlay" : "Footprint geometry"}
      role="img"
    >
      {[
        ...(previous ? [{ p: previous, c: "#669dbb" }] : []),
        { p: part, c: previous ? "#dd975c" : "var(--fd-accent)" },
      ].map(({ p, c }, i) => (
        <g key={i}>
          <path d={path(p.contours)} fill={c} fillOpacity=".15" stroke={c} strokeWidth=".06" />
          {!previous &&
            p.pads.map((pad, j) => (
              <rect
                key={j}
                x={pad.x - pad.w / 2}
                y={pad.y - pad.h / 2}
                width={pad.w}
                height={pad.h}
                fill="#d5b271"
                transform={`rotate(${-pad.angle} ${pad.x} ${pad.y})`}
              />
            ))}
          {p.pads
            .filter((p) => p.number === "1")
            .map((pad, j) => (
              <circle
                key={j}
                cx={pad.x}
                cy={pad.y}
                r=".22"
                fill={previous ? c : "#ed925d"}
                stroke="white"
                strokeWidth=".04"
              />
            ))}
        </g>
      ))}
    </svg>
  );
}
export function FootprintLibrary({
  target,
  initial,
  onClose,
  onPreview,
}: {
  target: PlacementPart | null;
  initial?: FootprintChoice;
  onClose: () => void;
  onPreview: (entry: FootprintChoice) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<FootprintChoice[]>([]),
    [choice, setChoice] = useState<FootprintChoice | null>(initial ?? null),
    [query, setQuery] = useState(""),
    [compatible, setCompatible] = useState(!!target),
    [error, setError] = useState(""),
    [dragging, setDragging] = useState(false);
  useEffect(() => {
    setChoice(initial ?? null);
    setCompatible(!!target);
    setDragging(false);
  }, [initial, target]);
  useEffect(() => {
    let live = true;
    void loadPlacementLibrary()
      .then((items) => {
        if (live) setItems(items);
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, []);
  const info = useMemo(
    () => (choice && target ? replacementPreview(target, choice.text, choice.name) : null),
    [target, choice],
  );
  const filtered = useMemo(
    () =>
      items.filter(
        (x) =>
          (x.name + " " + x.title).toLowerCase().includes(query.toLowerCase()) &&
          (!compatible || !target || replacementPreview(target, x.text, x.name).compatible),
      ),
    [items, query, compatible, target],
  );
  const numbers =
    info && target
      ? [
          ...new Set(
            [...target.pads, ...info.candidate.pads]
              .filter((p) => p.number && p.type !== "np_thru_hole")
              .map((p) => p.number),
          ),
        ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      : [];
  return (
    <Dialog
      open
      className={`w-[1060px]${dragging ? " fd-placement-library-dragging" : ""}`}
      title={target ? `Compare pad patterns for ${target.ref}` : "Add an unconnected footprint"}
      onClose={onClose}
    >
      <div className="fd-placement-library" data-testid="placement-library">
        <p>
          KiCad community library · 42 footprints ·{" "}
          <a href="https://www.kicad.org/libraries/license/" target="_blank" rel="noreferrer">
            CC-BY-SA with design exception
          </a>
        </p>
        <p className="fd-placement-library-purpose">{target ? "Compare the physical pads and size of this component. This does not choose a replacement electronic part or change the schematic." : "A footprint is a physical pad pattern on the PCB. Add one for layout exploration only; it has no circuit connections or BOM part."}</p>
        <div className="fd-placement-library-search">
          <input
            aria-label="Search footprint library"
            placeholder="Search packages, names or sizes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {target && <label>
            <input
              type="checkbox"
              checked={compatible}
              disabled={!target}
              onChange={(e) => setCompatible(e.target.checked)}
            />{" "}
            Matching numbered pads only
          </label>}
        </div>
        <div className={`fd-placement-library-columns${choice ? "" : " has-no-choice"}`}>
          <div className="fd-placement-library-grid">
            <small>
              {filtered.length} of {items.length} footprints
            </small>
            {filtered.map((x) => (
              <button
                key={x.name}
                className={choice?.name === x.name ? "is-selected" : ""}
                aria-label={`Choose ${x.title}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    "application/x-fabdesk-footprint",
                    JSON.stringify({ name: x.name, title: x.title, text: x.text }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                  // Keep the source mounted until dragend; unmounting cancels native drops.
                  setTimeout(() => setDragging(true), 0);
                }}
                onDragEnd={(e) => {
                  setDragging(false);
                  if (e.dataTransfer.dropEffect === "none") onClose();
                }}
                onClick={() => setChoice(x)}
              >
                <FootprintPicture part={x.part} />
                <strong>{x.title}</strong>
                <small>{x.name}</small>
              </button>
            ))}
          </div>
          <section className="fd-placement-comparison" hidden={!choice}>
            {choice ? (
              <>
                <h3>
                  {target ? `${target.ref} → ` : ""}
                  {choice.title}
                </h3>
                <FootprintPicture
                  part={info?.candidate ?? choice.part}
                  {...(target ? { previous: target } : {})}
                />
                {info ? (
                  <>
                    <p>Blue: current · Orange: new · Dots: pin 1</p>
                    <p>
                      {info.oldSize.map(fmt).join(" × ")} → {info.newSize.map(fmt).join(" × ")} mm
                    </p>
                    <p role="status">
                      {info.error ?? "Numbered pads match. Nets will be retained."}
                    </p>
                    <table>
                      <thead>
                        <tr>
                          <th>Pad</th>
                          <th>Current net</th>
                          <th>New pad</th>
                        </tr>
                      </thead>
                      <tbody>
                        {numbers.map((n) => (
                          <tr key={n}>
                            <td>{n}</td>
                            <td>
                              {target?.pads.find((p) => p.number === n)?.net || "Unconnected"}
                            </td>
                            <td>
                              {info.candidate.pads.some((p) => p.number === n)
                                ? "Present"
                                : "Missing"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p>
                    New pad pattern · no electrical connections. Add at the board center, or drag a
                    library card onto the board.
                  </p>
                )}
                <p>
                  Matching pad numbers and dimensions do not prove electrical compatibility. Check
                  pin 1 and the datasheet. The schematic is unchanged.
                </p>
              </>
            ) : (
              <p>Select a footprint to compare shape, dimensions and pads.</p>
            )}
          </section>
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <div className="fd-placement-file-button"><Button variant="secondary" onClick={() => fileInput.current?.click()}>Import footprint file…</Button>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".kicad_mod"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 1_000_000) throw Error("Choose a footprint smaller than 1 MB.");
                  const text = await file.text(),
                    name = file.name.replace(/\.kicad_mod$/i, "");
                  setChoice({ name, title: name, text, part: partFromNode(parse(text), 0) });
                  setError("");
                } catch (e) {
                  setError(String(e));
                }
              }}
            />
          </div>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!choice || !!target?.locked || (!!info && !info.compatible)}
            onClick={() => {
              if (choice) onPreview(choice);
            }}
          >
            Preview {target ? "pad change" : "unconnected footprint"}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
