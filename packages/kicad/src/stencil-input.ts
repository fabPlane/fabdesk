type Node = { start: number; end: number; atoms: string[]; children: Node[] };

/** Read-only projection for kicadts: it cannot parse some nightly metadata or
 * custom copper-pad primitives. Only omit annotations and pads that cannot
 * contribute to the requested paste layer (keep NPTHs for optional alignment).
 * Unknown paste geometry is never silently discarded. Preserve all other text. */
export function stencilParseInput(text: string, side: "F" | "B"): string {
  const roots: Node[] = [],
    stack: Node[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0],
      index = match.index;
    if (token === "(") {
      const node: Node = { start: index, end: 0, atoms: [], children: [] };
      (stack.at(-1)?.children ?? roots).push(node);
      stack.push(node);
    } else if (token === ")") {
      const node = stack.pop();
      if (!node) throw new Error("unbalanced parentheses in board file");
      node.end = index + 1;
    } else {
      if (!stack.length) throw new Error("expected a KiCad board expression");
      stack
        .at(-1)!
        .atoms.push(token.startsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, "$1") : token);
    }
  }
  if (stack.length || roots.length !== 1 || roots[0]!.atoms[0] !== "kicad_pcb") {
    throw new Error("unbalanced or invalid KiCad board expression");
  }
  const omit: Node[] = [];
  function visit(node: Node): void {
    const name = node.atoms[0];
    // Text render caches are derived data; paste text itself remains unsupported
    // and is rejected after parsing, so its cached geometry is never substituted.
    if (name === "custom_property" || name === "render_cache") {
      omit.push(node);
      return;
    }
    if (name === "pad") {
      const layers = node.children.find((c) => c.atoms[0] === "layers")?.atoms.slice(1) ?? [];
      const paste = layers.some(
        (l) => l === `${side}.Paste` || l === "*.Paste" || l === "F&B.Paste",
      );
      const npth = node.atoms[2] === "np_thru_hole" || node.atoms[2] === "npth";
      if (!paste && !npth) {
        omit.push(node);
        return;
      }
      if (paste && !["rect", "roundrect", "oval", "circle"].includes(node.atoms[3] ?? "")) {
        throw new Error(
          `Unsupported paste pad ${node.atoms[1]}: ${node.atoms[3]}; export native paste Gerbers instead.`,
        );
      }
    }
    for (const child of node.children) visit(child);
  }
  visit(roots[0]!);
  let result = "",
    cursor = 0;
  for (const node of omit) {
    result += text.slice(cursor, node.start);
    cursor = node.end;
  }
  return result + text.slice(cursor);
}
