import { Quaternion, Vector3 } from "three";

type View = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right";
const faces = [
  {
    view: "top",
    label: "Top",
    normal: [0, 0, 1],
    points: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    view: "bottom",
    label: "Bottom",
    normal: [0, 0, -1],
    points: [
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
      [-1, -1, -1],
    ],
  },
  {
    view: "front",
    label: "Front",
    normal: [0, -1, 0],
    points: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    view: "back",
    label: "Back",
    normal: [0, 1, 0],
    points: [
      [1, 1, -1],
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    view: "left",
    label: "Left",
    normal: [-1, 0, 0],
    points: [
      [-1, 1, -1],
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
    ],
  },
  {
    view: "right",
    label: "Right",
    normal: [1, 0, 0],
    points: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
] as const;

/** A live orientation indicator. Every visible face is also a keyboard-accessible view preset. */
export function MechanicalViewCube({
  orientation,
  onView,
}: {
  orientation: [number, number, number, number];
  onView: (view: View) => void;
}) {
  const rotation = new Quaternion(...orientation);
  const project = (p: readonly number[]) => {
    const v = new Vector3(p[0], p[1], p[2]).applyQuaternion(rotation);
    return { x: 46 + v.x * 20, y: 44 - v.y * 20, z: v.z };
  };
  return (
    <nav className="fd-reference-viewcube" aria-label="View orientation">
      <svg width="92" height="88" viewBox="0 0 92 88" aria-label="3D orientation cube">
        {faces
          .filter((f) => new Vector3(...f.normal).applyQuaternion(rotation).z > 0.001)
          .map((f) => {
            const points = f.points.map(project),
              center = project(f.normal);
            return (
              <g
                key={f.view}
                role="button"
                tabIndex={0}
                aria-label={`${f.label} view`}
                onClick={() => onView(f.view)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onView(f.view);
                  }
                }}
              >
                <polygon points={points.map((p) => `${p.x},${p.y}`).join(" ")} />
                <text x={center.x} y={center.y + 3} textAnchor="middle">
                  {f.label}
                </text>
              </g>
            );
          })}
        {(
          [
            [1, 0, 0, "X", "#e18c83"],
            [0, 1, 0, "Y", "#81bb96"],
            [0, 0, 1, "Z", "#85a9ed"],
          ] as const
        ).map(([x, y, z, label, color]) => {
          const a = project([x * 1.6, y * 1.6, z * 1.6]);
          return (
            <text key={label} x={a.x} y={a.y + 3} textAnchor="middle" fill={color}>
              {label}
            </text>
          );
        })}
      </svg>
      <button onClick={() => onView("iso")} title="Isometric view">
        3D
      </button>
    </nav>
  );
}
