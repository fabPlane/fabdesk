import type { MechanicalFitIssue } from "@fabdesk/protocol";

const topics = {
  secure: {
    title: "Secure the boards",
    detail: "Check that screws or holders keep each board in place.",
  },
  plugs: { title: "Check plug space", detail: "Make sure plugs and cables can reach the ports." },
  models: {
    title: "Check missing shapes",
    detail: "Some parts could not be checked in 3D. Add their models or check their size.",
  },
  fit: { title: "Check room inside", detail: "Make sure boards and parts have space around them." },
  other: { title: "Other checks", detail: "Review these findings before printing." },
  method: {
    title: "How the checks work",
    detail: "What was checked, and what the preview cannot confirm.",
  },
};
export type EnclosureReviewTopic = keyof typeof topics;

function topicFor(code: string): EnclosureReviewTopic {
  if (
    [
      "coverage",
      "import-coverage",
      "shell-coverage",
      "detailed-coverage",
      "detailed-layers",
      "assembly-sampled",
    ].includes(code)
  )
    return "method";
  if (/^(mount-|screw-|holder-|closure-)/.test(code)) return "secure";
  if (/^(port-|plug-|cable-|connector-|opening-|hardware-access)/.test(code)) return "plugs";
  if (
    ["detailed-missing", "detailed-open", "detailed-unavailable", "assembly-unavailable"].includes(
      code,
    )
  )
    return "models";
  if (
    /^(board-|outside-space|obstacle|shell-|native-|detailed-|assembly-|dimensions|fit-allowance)/.test(
      code,
    )
  )
    return "fit";
  return "other";
}

/** Only groups review notes. Errors must always remain visible on their own. */
export function enclosureReviewGroups(issues: readonly MechanicalFitIssue[]) {
  return (Object.keys(topics) as EnclosureReviewTopic[])
    .map((id) => ({
      id,
      ...topics[id],
      issues: issues.filter((issue) => issue.severity !== "error" && topicFor(issue.code) === id),
    }))
    .filter((group) => group.issues.length > 0);
}

/** The exact source finding remains available beside these short explanations. */
export const enclosureIssueSummary: Record<string, string> = {
  "mount-none": "This board needs screws or a holder to stay in place.",
  "board-geometry":
    "The board has an unusual or incomplete outline. Its size is estimated as a rectangle.",
  "screw-tool-access": "A part may get in the way of the screwdriver.",
  "screw-head-unknown": "Add the size of the screws you plan to use.",
  "port-measurements": "The port or plug size is estimated. Check its real size before printing.",
  "detailed-missing": "Some parts have no 3D shape, so the app could not check whether they fit.",
  "detailed-open": "Some 3D shapes are incomplete, so the fit check could not use them.",
  "detailed-layers":
    "Flat board artwork was skipped. Solder and surface contact still need checking.",
  "assembly-sampled":
    "No obstruction was found at the tested positions. This does not prove the part can be installed or removed.",
};
