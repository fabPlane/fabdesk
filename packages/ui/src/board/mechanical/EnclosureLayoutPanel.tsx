import { useState } from "react";
import {
  connectorOpening,
  DEFAULT_OPENING_CLEARANCE,
  enclosureOpeningClearance,
  type MechanicalDesign,
} from "@fabdesk/protocol";
import {
  connectorAccess,
  enclosureFileLabel,
  type LayoutBoard,
  type EnclosureLayoutGoal,
  type proposeEnclosureLayout,
} from "@fabdesk/client-core";
import { NumberField } from "./EnclosureNumberField";
import { EnclosureDimensionEvidence } from "./EnclosureDimensionEvidence";

type Proposal = ReturnType<typeof proposeEnclosureLayout>;
export type LayoutChoice = { goal: EnclosureLayoutGoal; proposal?: Proposal; error?: string };
const goals = { compact: "Compact", assembly: "Assembly space", ports: "Ports together" };
const walls = { minX: "Left · −X", maxX: "Right · +X", minY: "Front · −Y", maxY: "Back · +Y" };
type PortSetting = NonNullable<MechanicalDesign["portAccess"]>[number];
export function EnclosureLayoutPanel({
  design,
  boards,
  busy,
  proposals,
  onChange,
  onFind,
  onUse,
  onCancel,
  showPlugs,
  onShowPlugs,
}: {
  design: MechanicalDesign;
  boards: LayoutBoard[];
  busy: boolean;
  proposals: LayoutChoice[] | null;
  onChange: (d: MechanicalDesign, label?: string) => void;
  onFind: () => void;
  onUse: (p: Proposal) => void;
  onCancel: () => void;
  showPlugs: boolean;
  onShowPlugs: (v: boolean) => void;
}) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [length, setLength] = useState(100),
    [slack, setSlack] = useState(10);
  const endpoints = boards.flatMap((b) =>
    (b.features.connectors ?? []).map((c) => ({
      value: JSON.stringify({ boardPath: b.placement.path, ref: c.ref }),
      label: `${enclosureFileLabel(b.placement.path)} · ${c.ref}`,
    })),
  );
  function port(setting: PortSetting) {
    onChange(
      {
        ...design,
        portAccess: [
          ...(design.portAccess ?? []).filter(
            (p) => p.boardPath !== setting.boardPath || p.ref !== setting.ref,
          ),
          setting,
        ],
      },
      "Connector requirements",
    );
  }
  return (
    <section className="fd-case-entry fd-layout-planner" aria-label="Automatic enclosure layout">
      <div className="fd-layout-heading">
        <strong>Plan your assembly</strong>
        <span>{design.boards.length} boards</span>
      </div>
      <p>Set the requirements that matter, then compare layouts before moving anything.</p>
      <fieldset disabled={busy}>
        <details>
          <summary>
            Keep boards in place <span>{design.boards.filter((b) => b.locked).length} locked</span>
          </summary>
          <p>
            Locked boards keep their position, height and rotation. The current case size stays
            fixed while any board is locked.
          </p>
          {design.boards.map((b) => (
            <label className="fd-case-confirm" key={b.path}>
              <input
                type="checkbox"
                checked={!!b.locked}
                onChange={(e) =>
                  onChange(
                    {
                      ...design,
                      boards: design.boards.map((p) =>
                        p.path === b.path ? { ...p, locked: e.target.checked } : p,
                      ),
                    },
                    "Board position lock",
                  )
                }
              />
              <span>{enclosureFileLabel(b.path)}</span>
            </label>
          ))}
        </details>
        <details data-enclosure-control="ports">
          <summary>
            Ports & plug access{" "}
            <span>
              {boards.reduce(
                (n, b) =>
                  n +
                  (b.features.connectors ?? []).filter(
                    (c) => connectorAccess(design, b.placement.path, c) === "external",
                  ).length,
                0,
              )}{" "}
              external
            </span>
          </summary>
          <p>
            Confirm which connectors need outside access. Opening and plug dimensions are
            rectangular envelopes; verify them against the real parts.
          </p>
          <NumberField
            label="Opening clearance per side"
            value={design.openingClearance ?? DEFAULT_OPENING_CLEARANCE}
            min={0}
            max={5}
            onChange={(v) => onChange({ ...design, openingClearance: v }, "Opening tolerance")}
          />
          <small>
            Independent of board clearance. Recalculate layouts after changing dimensions.
          </small>
          {boards.map((b) =>
            (b.features.connectors ?? []).map((c) => {
              const setting: PortSetting = design.portAccess?.find(
                (p) => p.boardPath === b.placement.path && p.ref === c.ref,
              ) ?? {
                boardPath: b.placement.path,
                ref: c.ref,
                access: connectorAccess(design, b.placement.path, c),
              };
              const opening = connectorOpening(c, setting.face ?? c.edge, setting.aperture);
              const padding = enclosureOpeningClearance(design);
              return (
                <details className="fd-layout-port" key={`${b.placement.path}:${c.ref}`}>
                  <summary>
                    {c.ref} <span>{setting.access}</span>
                    <small>{enclosureFileLabel(b.placement.path)}</small>
                  </summary>
                  <label className="fd-case-confirm">
                    <input
                      type="checkbox"
                      checked={setting.access === "external"}
                      onChange={(e) =>
                        port({ ...setting, access: e.target.checked ? "external" : "internal" })
                      }
                    />
                    <span>Needs outside access</span>
                  </label>
                  {setting.access === "external" && (
                    <>
                      <p className="fd-case-hint">
                        {opening.shape === "rounded" ? "Rounded ends" : "Rectangle"} · Opening{" "}
                        {(opening.width + 2 * padding).toFixed(2)} ×{" "}
                        {(opening.height + 2 * padding).toFixed(2)} mm · {padding.toFixed(2)} mm
                        clearance per side.
                        <br />
                        {opening.source === "fabrication-outline"
                          ? "Body outline from PCB; height estimated."
                          : opening.source}
                      </p>
                      <label>
                        Connector faces (on PCB)
                        <select
                          aria-label={`${c.ref} facing edge`}
                          value={setting.face ?? ""}
                          onChange={(e) => {
                            const { face: _, ...rest } = setting;
                            port({
                              ...rest,
                              ...(e.target.value
                                ? { face: e.target.value as NonNullable<PortSetting["face"]> }
                                : {}),
                            });
                          }}
                        >
                          <option value="">Inferred: {walls[c.edge]}</option>
                          {Object.entries(walls).map(([v, n]) => (
                            <option key={v} value={v}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Preferred case wall
                        <select
                          aria-label={`${c.ref} preferred wall`}
                          value={setting.wall ?? ""}
                          onChange={(e) => {
                            const { wall: _, ...rest } = setting;
                            port({
                              ...rest,
                              ...(e.target.value
                                ? { wall: e.target.value as NonNullable<PortSetting["wall"]> }
                                : {}),
                            });
                          }}
                        >
                          <option value="">Any wall</option>
                          {Object.entries(walls).map(([v, n]) => (
                            <option key={v} value={v}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="fd-case-confirm">
                        <input
                          type="checkbox"
                          checked={!!setting.aperture}
                          onChange={(e) => {
                            const { aperture: _, ...rest } = setting;
                            port({
                              ...rest,
                              ...(e.target.checked
                                ? {
                                    aperture: {
                                      width: connectorOpening(c, setting.face ?? c.edge).width,
                                      height: connectorOpening(c).height,
                                    },
                                  }
                                : {}),
                            });
                          }}
                        />
                        <span>Customize opening</span>
                      </label>
                      {setting.aperture && (
                        <>
                          <label>
                            Opening shape
                            <select
                              aria-label={`${c.ref} opening shape`}
                              value={opening.shape}
                              onChange={(e) =>
                                port({
                                  ...setting,
                                  aperture: {
                                    ...setting.aperture!,
                                    shape: e.target.value as "rectangle" | "rounded",
                                    evidence: { kind: "estimate" },
                                  },
                                })
                              }
                            >
                              <option value="rounded">Rounded ends · USB-C</option>
                              <option value="rectangle">Rectangle</option>
                            </select>
                          </label>
                          <small>
                            Enter the opening before clearance is added. Check the actual connector
                            and plug before printing.
                          </small>
                          <div className="fd-case-grid">
                            {(["width", "height"] as const).map((k) => (
                              <NumberField
                                key={k}
                                label={`Opening ${k}`}
                                value={setting.aperture![k]}
                                min={0.1}
                                max={2000}
                                onChange={(v) =>
                                  port({
                                    ...setting,
                                    aperture: {
                                      ...setting.aperture!,
                                      [k]: v,
                                      evidence: { kind: "estimate" },
                                    },
                                  })
                                }
                              />
                            ))}
                          </div>
                          <EnclosureDimensionEvidence
                            label={`${c.ref} opening`}
                            value={setting.aperture.evidence}
                            onChange={(evidence) =>
                              port({ ...setting, aperture: { ...setting.aperture!, evidence } })
                            }
                          />
                        </>
                      )}
                      <label className="fd-case-confirm">
                        <input
                          type="checkbox"
                          checked={!!setting.plug}
                          onChange={(e) => {
                            const { plug: _, ...rest } = setting;
                            port({
                              ...rest,
                              ...(e.target.checked
                                ? {
                                    plug: {
                                      width: c.widthMm + 4,
                                      height: c.heightMm + 4,
                                      depth: 20,
                                      reach: 0,
                                      travel: 10,
                                    },
                                  }
                                : {}),
                            });
                          }}
                        />
                        <span>Check plug body & reach</span>
                      </label>
                      {setting.plug && (
                        <>
                          <small>
                            Replace these starting dimensions with your actual plug. Reach is the
                            usable mating length from the plug shoulder; zero remains blocked.
                            Removal space reserves extra room to pull the plug or card out.
                          </small>
                          <div className="fd-case-grid">
                            {(["width", "height", "depth", "reach", "travel"] as const).map((k) => (
                              <NumberField
                                key={k}
                                label={
                                  k === "reach"
                                    ? "Mating reach"
                                    : k === "travel"
                                      ? "Removal space"
                                      : `Plug ${k}`
                                }
                                value={setting.plug![k] ?? 0}
                                min={k === "reach" || k === "travel" ? 0 : 0.1}
                                max={k === "reach" || k === "travel" ? 200 : 2000}
                                onChange={(v) =>
                                  port({
                                    ...setting,
                                    plug: {
                                      ...setting.plug!,
                                      [k]: v,
                                      evidence: { kind: "estimate" },
                                    },
                                  })
                                }
                              />
                            ))}
                          </div>
                          <EnclosureDimensionEvidence
                            label={`${c.ref} plug`}
                            value={setting.plug.evidence}
                            onChange={(evidence) =>
                              port({ ...setting, plug: { ...setting.plug!, evidence } })
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                </details>
              );
            }),
          )}
          <label className="fd-case-confirm">
            <input
              type="checkbox"
              checked={showPlugs}
              onChange={(e) => onShowPlugs(e.target.checked)}
            />
            <span>Show plug & cable guides in 3D</span>
          </label>
        </details>
        <details data-enclosure-control="cables">
          <summary>
            Cable connections <span>{design.connections?.length ?? 0} defined</span>
          </summary>
          <p>
            Choose the connectors and usable cable length. Turn on route planning to reserve space
            around other parts and bends. Cable dimensions come from your cable drawing.
          </p>
          <label className="fd-case-confirm">
            <input
              type="checkbox"
              checked={showPlugs}
              onChange={(e) => onShowPlugs(e.target.checked)}
            />
            <span>Show cable guides in 3D · planned corridors or direct distance</span>
          </label>
          {(design.connections ?? []).map((c) => (
            <div className="fd-layout-cable" key={c.id}>
              <strong>
                {c.from.ref} → {c.to.ref}
              </strong>
              <small>
                {enclosureFileLabel(c.from.boardPath)} → {enclosureFileLabel(c.to.boardPath)}
              </small>
              <div className="fd-case-grid">
                {(["length", "slack"] as const).map((k) => (
                  <NumberField
                    key={k}
                    label={k === "length" ? "Cable length" : "Bend / slack allowance"}
                    value={c[k]}
                    min={k === "length" ? 0.1 : 0}
                    max={k === "length" ? 2000 : 1000}
                    onChange={(v) =>
                      onChange(
                        {
                          ...design,
                          connections: design.connections!.map((p) =>
                            p.id === c.id ? { ...p, [k]: v } : p,
                          ),
                        },
                        "Cable allowance",
                      )
                    }
                  />
                ))}
              </div>
              <label className="fd-case-confirm">
                <input
                  type="checkbox"
                  checked={!!c.routing}
                  onChange={(e) =>
                    onChange(
                      {
                        ...design,
                        connections: design.connections!.map((p) => {
                          if (p.id !== c.id) return p;
                          const { routing: _routing, ...rest } = p;
                          return e.target.checked
                            ? { ...rest, routing: { diameter: 2, bendRadius: 5 } }
                            : rest;
                        }),
                      },
                      "Cable route planning",
                    )
                  }
                />
                <span>Plan a clear cable route</span>
              </label>
              {c.routing && (
                <>
                  <small>
                    Starting estimates — confirm for your cable. For ribbon cables, use the full
                    width as the reserved diameter.
                  </small>
                  <div className="fd-case-grid">
                    {(["diameter", "bendRadius"] as const).map((key) => (
                      <NumberField
                        key={key}
                        label={key === "diameter" ? "Cable space / width" : "Minimum bend radius"}
                        value={c.routing![key]}
                        min={0.1}
                        max={key === "diameter" ? 50 : 100}
                        onChange={(value) =>
                          onChange(
                            {
                              ...design,
                              connections: design.connections!.map((p) =>
                                p.id === c.id
                                  ? { ...p, routing: { ...c.routing!, [key]: value } }
                                  : p,
                              ),
                            },
                            "Cable dimensions",
                          )
                        }
                      />
                    ))}
                  </div>
                </>
              )}
              <button
                onClick={() =>
                  onChange(
                    { ...design, connections: design.connections!.filter((p) => p.id !== c.id) },
                    "Remove cable",
                  )
                }
              >
                Remove connection
              </button>
            </div>
          ))}
          <label>
            From connector
            <select
              aria-label="Cable from connector"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="">Choose connector…</option>
              {endpoints.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            To connector
            <select
              aria-label="Cable to connector"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="">Choose connector…</option>
              {endpoints
                .filter((p) => p.value !== from)
                .map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
            </select>
          </label>
          <div className="fd-case-grid">
            <NumberField
              label="Cable length"
              value={length}
              min={0.1}
              max={2000}
              onChange={setLength}
            />
            <NumberField
              label="Bend / slack allowance"
              value={slack}
              min={0}
              max={1000}
              onChange={setSlack}
            />
          </div>
          <button
            disabled={
              !from ||
              !to ||
              from === to ||
              length <= slack ||
              (design.connections?.length ?? 0) >= 100
            }
            onClick={() => {
              onChange(
                {
                  ...design,
                  connections: [
                    ...(design.connections ?? []),
                    {
                      id: crypto.randomUUID(),
                      from: JSON.parse(from),
                      to: JSON.parse(to),
                      length,
                      slack,
                    },
                  ],
                },
                "Add cable connection",
              );
              setFrom("");
              setTo("");
            }}
          >
            Add connection
          </button>
        </details>
        <label className="fd-case-confirm" data-enclosure-control="print-area">
          <input
            type="checkbox"
            checked={!!design.layoutLimit}
            onChange={(e) => {
              const { layoutLimit: _limit, ...rest } = design;
              onChange(
                e.target.checked ? { ...rest, layoutLimit: { width: 250, depth: 250 } } : rest,
                "Print area limit",
              );
            }}
          />
          <span>Keep the case within my print area</span>
        </label>
        {design.layoutLimit && (
          <>
            <p>
              Usable print area after brim and edge margin. Includes case walls and lid-screw
              mounts. Print the base and lid separately; check their placement in your slicer.
            </p>
            <div className="fd-case-grid">
              {(["width", "depth"] as const).map((key) => (
                <NumberField
                  key={key}
                  label={key === "width" ? "Print width" : "Print depth"}
                  value={design.layoutLimit![key]}
                  min={1}
                  max={2000}
                  onChange={(value) =>
                    onChange(
                      { ...design, layoutLimit: { ...design.layoutLimit!, [key]: value } },
                      "Print area limit",
                    )
                  }
                />
              ))}
            </div>
          </>
        )}
        <button className="fd-mechanical-primary" disabled={!design.boards.length} onClick={onFind}>
          Compare layouts
        </button>
      </fieldset>
      {proposals && (
        <div className="fd-layout-choices" aria-live="polite">
          {proposals.map(({ goal, proposal: p, error }) => (
            <article className="fd-layout-choice" key={goal}>
              <strong>{goals[goal]}</strong>
              <small>
                {goal === "compact"
                  ? "Prioritize a smaller footprint"
                  : goal === "assembly"
                    ? "Leave more space between boards"
                    : "Prefer fewer case walls for ports"}
              </small>
              {p ? (
                <>
                  <div className="fd-layout-size">
                    {p.design.space.width} × {p.design.space.depth} × {p.design.space.height}{" "}
                    <small>mm inside</small>
                  </div>
                  <dl>
                    <div>
                      <dt>Layouts checked</dt>
                      <dd>{p.search.attempts}</dd>
                    </div>
                    <div>
                      <dt>Accessible ports</dt>
                      <dd>
                        {p.openingsAdded} / {p.externalPorts}
                      </dd>
                    </div>
                    <div>
                      <dt>Port walls</dt>
                      <dd>{p.wallCount}</dd>
                    </div>
                    <div>
                      <dt>Board spacing</dt>
                      <dd>{p.boardGap} mm</dd>
                    </div>
                    {!!p.cables.length && (
                      <div>
                        <dt>Cable length checks</dt>
                        <dd>
                          {p.cables.filter((c) => c.reachable).length} / {p.cables.length}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {!!p.unresolved.length && (
                    <p className="fd-case-input-error">
                      {p.unresolved.length} ports still need manual review.
                    </p>
                  )}
                  <details>
                    <summary>Assumptions & checks</summary>
                    {[...p.unresolved, ...p.notes].map((n) => (
                      <p key={n}>{n}</p>
                    ))}
                  </details>
                  <button disabled={busy} onClick={() => onUse(p)}>
                    Use {goals[goal].toLowerCase()}
                  </button>
                </>
              ) : (
                <p role="status">{error}</p>
              )}
            </article>
          ))}
          <small>
            Different priorities can produce the same layout. These are search results, not proof of
            a global optimum.
          </small>
          <button disabled={busy} onClick={onCancel}>
            Dismiss comparison
          </button>
        </div>
      )}
    </section>
  );
}
