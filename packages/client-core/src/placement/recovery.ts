import { decodeAutosave } from "./engine";
import type { PlacementSession } from "./types";

export const DEVICE_PLACEMENT_RECOVERY = "Device recovery.placement.json";

/** A bad device copy must not hide a valid shared draft or original project board. */
export async function restorePlacement({
  readRecovery,
  readFile,
  parse,
  paths,
  signal,
}: {
  readRecovery: () => string | null;
  readFile: (path: string) => Promise<string>;
  parse: (text: string, name: string) => Promise<PlacementSession>;
  paths: string[];
  signal: AbortSignal;
}): Promise<{ session: PlacementSession; source: string; skipped: string[] } | null> {
  const skipped: string[] = [];
  const check = () => {
    if (signal.aborted) throw new DOMException("Canceled", "AbortError");
  };
  check();
  try {
    const raw = readRecovery();
    if (raw) {
      const text = await decodeAutosave(raw);
      check();
      const session = await parse(text, DEVICE_PLACEMENT_RECOVERY);
      check();
      return { session, source: DEVICE_PLACEMENT_RECOVERY, skipped };
    }
  } catch {
    check();
    skipped.push("device recovery");
  }
  for (const source of paths) {
    check();
    try {
      const text = await readFile(source);
      check();
      const session = await parse(text, source.split(/[\\/]/).at(-1)!);
      check();
      return { session, source, skipped };
    } catch {
      check();
      skipped.push(source);
    }
  }
  if (skipped.length)
    throw new Error(`Could not open ${skipped.join(", ")}. Choose a board or session using Open.`);
  return null;
}
