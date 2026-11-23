export interface ProjectLibraryRow {
  name: string;
  type: string;
  uri: string;
  options: string;
  descr: string;
  disabled: boolean;
  hidden: boolean;
}

type Node = string | Node[];

function tokenize(text: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "(") {
      const list: Node[] = [];
      stack.at(-1)!.push(list);
      stack.push(list);
      i++;
    } else if (c === ")") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === "n" ? "\n" : next;
          i += 2;
        } else value += text[i++];
      }
      i++;
      stack.at(-1)!.push(value);
    } else if (/\s/.test(c)) i++;
    else {
      let atom = "";
      while (i < text.length && !/[\s()"]/.test(text[i]!)) atom += text[i++];
      stack.at(-1)!.push(atom);
    }
  }
  return root;
}

/** Rows of a saved KiCad library table; malformed or unknown entries are skipped, never thrown. */
export function parseLibraryTable(text: string): ProjectLibraryRow[] {
  const table = tokenize(text).find((n): n is Node[] => Array.isArray(n) && /^(fp|sym)_lib_table$/.test(String(n[0])));
  if (!table) return [];
  const rows: ProjectLibraryRow[] = [];
  for (const entry of table) {
    if (!Array.isArray(entry) || entry[0] !== "lib") continue;
    const field = (key: string): string | undefined => {
      const node = entry.find((n): n is Node[] => Array.isArray(n) && n[0] === key);
      return node && typeof node[1] === "string" ? node[1] : undefined;
    };
    const flag = (key: string): boolean => entry.some((n) => Array.isArray(n) && n[0] === key);
    const name = field("name");
    const uri = field("uri");
    if (!name || uri === undefined) continue;
    rows.push({
      name,
      type: field("type") ?? "KiCad",
      uri,
      options: field("options") ?? "",
      descr: field("descr") ?? "",
      disabled: flag("disabled"),
      hidden: flag("hidden"),
    });
  }
  return rows;
}


export function serializeLibraryTable(kind: "footprint" | "symbol", rows: ProjectLibraryRow[]): string {
  const q = JSON.stringify;
  return `(${kind === "footprint" ? "fp" : "sym"}_lib_table\n  (version 7)\n` + rows.map(r => `  (lib (name ${q(r.name)}) (type ${q(r.type)}) (uri ${q(r.uri)}) (options ${q(r.options)}) (descr ${q(r.descr)})${r.disabled ? " (disabled)" : ""}${r.hidden ? " (hidden)" : ""})`).join("\n") + "\n)\n";
}
