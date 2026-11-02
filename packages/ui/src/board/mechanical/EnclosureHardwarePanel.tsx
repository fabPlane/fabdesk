import type { MechanicalDesign } from "@fabdesk/protocol";
import { enclosureFileLabel } from "@fabdesk/client-core";
import { NumberField } from "./EnclosureNumberField";

/** Progressive disclosure: two simple choices, with fastener dimensions available when needed. */
export function EnclosureHardwarePanel({
  design,
  onChange,
}: {
  design: MechanicalDesign;
  onChange: (d: MechanicalDesign) => void;
}) {
  const screws = design.closure?.kind === "screws";
  return (
    <details className="fd-case-hardware">
      <summary>
        {design.mode === "generated" ? "Lid, holders & detailed fit" : "Detailed fit"}
      </summary>
      <label className="fd-case-confirm">
        <input
          type="checkbox"
          checked={design.detailedFit ?? false}
          onChange={(e) => onChange({ ...design, detailedFit: e.target.checked })}
        />
        <span>Check actual 3D models</span>
      </label>
      <p className="fd-case-hint">
        Slower, more detailed collision checks using KiCad models. Missing models stay flagged for
        review.
      </p>
      {design.mode === "generated" && (
        <>
          <label className="fd-case-confirm">
            <input
              type="checkbox"
              checked={(design.fitAllowance ?? 0) > 0}
              onChange={(e) => onChange({ ...design, fitAllowance: e.target.checked ? 0.1 : 0 })}
            />
            <span>Allow for small sizing differences</span>
          </label>
          <p className="fd-case-hint">
            Adds room at the lid and edge holders, and checks screws and port clearance. Preview
            again; existing openings may need resizing. This is an assumption about your printer,
            not a measured result.
          </p>
          {(design.fitAllowance ?? 0) > 0 && (
            <label>
              Assumed error per surface
              <select
                aria-label="Assumed error per surface"
                value={design.fitAllowance}
                onChange={(e) => onChange({ ...design, fitAllowance: Number(e.target.value) })}
              >
                {[...new Set([0.1, 0.15, 0.2, design.fitAllowance!])]
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={v}>
                      ±{v.toFixed(2)} mm
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Lid fastening
            <select
              aria-label="Lid fastening"
              value={screws ? "screws" : "lift-off"}
              onChange={(e) =>
                onChange({
                  ...design,
                  closure: {
                    screwDiameter: 3,
                    screwLength: 8,
                    pilotDiameter: 2.5,
                    clearanceDiameter: 3.4,
                    bossDiameter: 8,
                    ...design.closure,
                    kind: e.target.value as "screws" | "lift-off",
                  },
                })
              }
            >
              <option value="lift-off">Lift-off lid</option>
              <option value="screws">Four lid screws</option>
            </select>
          </label>
          <p className="fd-case-hint">
            Screw lugs sit outside the case to keep the board space clear. The preview checks port
            access.
          </p>
          {screws && design.closure && (
            <details>
              <summary>Screw dimensions</summary>
              {(
                [
                  ["screwDiameter", "Screw diameter"],
                  ["screwLength", "Screw length"],
                  ["pilotDiameter", "Pilot hole"],
                  ["clearanceDiameter", "Lid clearance hole"],
                  ["bossDiameter", "Lug diameter"],
                ] as const
              ).map(([key, label]) => (
                <NumberField
                  key={key}
                  label={label}
                  value={design.closure![key]}
                  min={
                    {
                      screwDiameter: 1,
                      screwLength: 3,
                      pilotDiameter: 0.5,
                      clearanceDiameter: 1,
                      bossDiameter: 5,
                    }[key]
                  }
                  max={
                    {
                      screwDiameter: 6,
                      screwLength: 40,
                      pilotDiameter: 6,
                      clearanceDiameter: 8,
                      bossDiameter: 20,
                    }[key]
                  }
                  onChange={(v) =>
                    onChange({ ...design, closure: { ...design.closure!, [key]: v } })
                  }
                />
              ))}
              <p className="fd-case-hint">
                Starting dimensions for M3-sized hardware. Match your screw and printing material;
                test the pilot hole before assembly.
              </p>
            </details>
          )}
          {design.boards.map((b) => (
            <label key={b.path}>
              {enclosureFileLabel(b.path)}
              <select
                aria-label={`${b.path} board retention`}
                value={design.holders?.find((h) => h.boardPath === b.path)?.kind ?? "posts"}
                onChange={(e) =>
                  onChange({
                    ...design,
                    holders: [
                      ...(design.holders ?? []).filter((h) => h.boardPath !== b.path),
                      ...(e.target.value === "corner-clamps" || e.target.value === "edge-clamps"
                        ? [
                            {
                              boardPath: b.path,
                              kind: e.target.value as "corner-clamps" | "edge-clamps",
                            },
                          ]
                        : []),
                    ],
                  })
                }
              >
                <option value="posts">Use mounting holes / custom retention</option>
                <option value="edge-clamps">Find clear edges · no PCB holes</option>
                <option value="corner-clamps">Corner holders · no PCB holes</option>
              </select>
            </label>
          ))}
          <p className="fd-case-hint">
            Holders need a screwed lid and a rectangular PCB. Find clear edges avoids occupied
            corners; if no suitable supports fit, the preview explains what needs room.
          </p>
        </>
      )}
    </details>
  );
}
