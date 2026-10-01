import type { NetlistFile } from "@fabdesk/protocol";

/** Selected compiler-path help; not injected into general project guidance. */
export const COMPILER_SOURCE_GUIDE = {
  contract: "fabdesk.compiler-source-guide/1.0.0",
  format: "netlist-json",
  required: {
    netlist: "Object containing components and nets arrays.",
    components:
      "Each component needs ref, value, footprint, and libSource: {lib, part} for schematic generation. Use exact KiCad library identifiers.",
    nets: "Each net needs name and nodes: [{ref, pin}]. Pin numbers are strings from the exact symbol; nodes are not strings or tuples.",
  },
  optional:
    "board may specify widthMm/heightMm, outline, rules and placements; libraries registers project libraries; netlist.noConnects explicitly marks unused pins.",
  example: {
    netlist: {
      components: [
        {
          ref: "R1",
          value: "1k",
          footprint: "Resistor_SMD:R_0805_2012Metric",
          libSource: { lib: "Device", part: "R" },
        },
        {
          ref: "R2",
          value: "2k",
          footprint: "Resistor_SMD:R_0805_2012Metric",
          libSource: { lib: "Device", part: "R" },
        },
      ],
      nets: [
        {
          name: "A",
          nodes: [
            { ref: "R1", pin: "1" },
            { ref: "R2", pin: "1" },
          ],
        },
        {
          name: "B",
          nodes: [
            { ref: "R1", pin: "2" },
            { ref: "R2", pin: "2" },
          ],
        },
      ],
    },
    board: { widthMm: 20, heightMm: 15 },
  } satisfies NetlistFile,
  limitation:
    "This two-resistor example illustrates the input format, not the requested circuit. Schema validity does not establish electrical correctness, routing, or release readiness.",
} as const;

export function compilerSourceHelp(errors: ReadonlyArray<{ type?: string }>) {
  return errors.some(({ type }) =>
    ["missing_entrypoint", "json_syntax", "bad_shape"].includes(type ?? ""),
  )
    ? COMPILER_SOURCE_GUIDE
    : undefined;
}

export function formatCompilerSourceHelp(guide: typeof COMPILER_SOURCE_GUIDE): string {
  return [
    "Compiler source format (netlist-json):",
    ...Object.entries(guide.required).map(([field, rule]) => field + ": " + rule),
    guide.optional,
    "Example source (adapt to the requested design): " + JSON.stringify(guide.example),
    guide.limitation,
  ].join("\n");
}
