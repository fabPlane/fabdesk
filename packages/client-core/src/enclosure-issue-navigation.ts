/** Stable destinations for fit findings; labels can change without breaking recovery links. */
const issueTargets = {
  boards: ["no-board", "board-geometry"],
  models: ["detailed-missing", "detailed-open", "detailed-unavailable", "detailed-layers"],
  placement: [
    "native-clearance",
    "outside-space",
    "board-collision",
    "detailed-collision",
    "detailed-clearance",
    "shell-surface",
    "shell-clearance",
    "assembly-obstruction",
    "screw-tool-access",
  ],
  dimensions: ["dimensions"],
  "print-area": ["case-size-limit"],
  openings: ["opening-web", "connector-opening", "opening-bounds"],
  cables: ["cable-route-blocked", "cable-endpoint", "cable-length", "cable-routing"],
  ports: ["port-wall", "port-measurements", "plug-reach", "plug-collision"],
  obstacles: ["obstacle"],
  mounts: [
    "mount-support",
    "mount-bearing",
    "mount-wall",
    "mount-overlap",
    "mount-none",
    "mount-hole",
    "mount-height",
    "mount-collision",
    "mount-bounds",
    "screw-head-unknown",
    "screw-head-clearance",
    "screw-head-size",
    "screw-shaft",
    "screw-length",
    "screw-engagement",
  ],
  "model-checks": ["assembly-unavailable"],
  "assembly-checks": ["assembly-sampled"],
  allowance: ["fit-allowance"],
  holders: [
    "holder-tolerance",
    "holder-space",
    "holder-collision",
    "holder-room",
    "holder-outline",
  ],
  lid: ["holder-closure"],
  "lid-screws": ["closure-length", "closure-size"],
  hardware: ["hardware-access"],
} as const;

export type EnclosureIssueTarget = keyof typeof issueTargets;

export function enclosureIssueRoute(code: string): {
  target: EnclosureIssueTarget;
  step: "PCB" | "Start";
  disclosure: "case" | "layout" | "size" | null;
} | null {
  const target = (Object.keys(issueTargets) as EnclosureIssueTarget[]).find((key) =>
    (issueTargets[key] as readonly string[]).includes(code),
  );
  if (!target) return null;
  return {
    target,
    step: target === "boards" || target === "models" ? "PCB" : "Start",
    disclosure: ["obstacles", "mounts", "openings"].includes(target)
      ? "case"
      : ["ports", "cables", "print-area"].includes(target)
        ? "layout"
        : target === "dimensions"
          ? "size"
          : null,
  };
}
