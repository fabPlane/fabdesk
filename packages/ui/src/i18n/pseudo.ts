import type { MessageCatalog, MessageKey } from "./catalogs/en";
import { messages as en } from "./catalogs/en";

const MAP: Record<string, string> = {
  A: "Å",
  E: "É",
  I: "Ï",
  O: "Ø",
  U: "Ü",
  a: "å",
  e: "é",
  i: "ï",
  o: "ø",
  u: "ü",
  c: "ç",
  n: "ñ",
  y: "ÿ",
};

/** Widen a string the way a long translation would, leaving ICU tokens intact. */
export function toPseudoString(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "{") {
      let depth = 0;
      let end = -1;
      for (let j = i; j < source.length; j++) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) {
        out += source.slice(i);
        break;
      }
      out += source.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const ch = source[i] ?? "";
    out += MAP[ch] ?? ch;
    i++;
  }
  return `[[[ ${out} ··· ]]]`;
}

export function toPseudoCatalog(source: MessageCatalog = en): MessageCatalog {
  const out = {} as MessageCatalog;
  for (const key of Object.keys(source) as MessageKey[]) {
    out[key] = toPseudoString(source[key]);
  }
  return out;
}
