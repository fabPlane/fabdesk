/** Build a project-local passive symbol library for router-only netlist fixtures. */

export interface RegressionNetlistSource {
  netlist?: {
    components?: Array<{
      ref?: string;
      value?: string;
      footprint?: unknown;
      libSource?: { lib: string; part: string };
    }>;
    nets?: Array<{ name?: string; nodes?: Array<{ ref?: string; pin?: string }> }>;
  };
  libraries?: Array<{ kind: string; nickname: string; uri: string }>;
}

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function prepareRegressionSymbols(
  input: RegressionNetlistSource,
  uri: string,
  nickname = "FabdeskRegression",
): { source: RegressionNetlistSource; library: string } {
  const source = structuredClone(input);
  const components = source.netlist?.components ?? [];
  // A one-pad net has nothing to route and produces an ERC single-pin-label error. It is noise in
  // a routing corpus, so omit it before compiling the temporary project.
  const nets = (source.netlist?.nets ?? []).filter((net) => (net.nodes?.length ?? 0) >= 2);
  if (source.netlist) source.netlist.nets = nets;

  const pins = new Map<string, Set<string>>();
  for (const net of nets) {
    for (const node of net.nodes ?? []) {
      if (!node.ref || !node.pin) continue;
      const found = pins.get(node.ref) ?? new Set<string>();
      found.add(node.pin);
      pins.set(node.ref, found);
    }
  }

  const symbols: string[] = [];
  for (const component of components) {
    if (!component.ref) throw new Error("regression component is missing ref");
    component.libSource = { lib: nickname, part: component.ref };
    const reference = component.ref.match(/^[A-Za-z]+/)?.[0] ?? "U";
    const numbers = [...(pins.get(component.ref) ?? [])].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const pinRows = numbers.map((number, index) => {
      const y = ((numbers.length - 1) / 2 - index) * 2.54;
      return `      (pin passive line (at -5.08 ${y} 0) (length 2.54)\n        (name ${quote(number)} (effects (font (size 1.27 1.27))))\n        (number ${quote(number)} (effects (font (size 1.27 1.27))))\n      )`;
    });
    symbols.push(`  (symbol ${quote(component.ref)} (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
    (property "Reference" ${quote(reference)} (at 0 2.54 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" ${quote(component.value ?? component.ref)} (at 0 -2.54 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "" (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "~" (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (symbol ${quote(`${component.ref}_1_1`)}
${pinRows.join("\n")}
    )
  )`);
  }

  source.libraries = [
    ...(source.libraries ?? []).filter(
      (library) => !(library.kind === "symbol" && library.nickname === nickname),
    ),
    { kind: "symbol", nickname, uri },
  ];
  return {
    source,
    library: `(kicad_symbol_lib (version 20220914) (generator fabdesk_regressions)\n${symbols.join("\n")}\n)\n`,
  };
}
