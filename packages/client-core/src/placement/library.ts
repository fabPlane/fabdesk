import data from "./library-data.json";
import { parse, partFromNode } from "./engine";
export const placementLibrary = data.map((entry) => ({
  ...entry,
  part: partFromNode(parse(entry.text), 0),
}));
