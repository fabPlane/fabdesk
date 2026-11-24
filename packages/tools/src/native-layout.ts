import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NativeSourceContext } from "@fabdesk/protocol";
import type { ProjectHandle } from "./registry";
export type NativeFileLayout = {
  context: NativeSourceContext;
  project: ProjectHandle;
  directory: string;
  files: Readonly<Record<string, string>>;
  cacheDirectory: string;
  captureRevision(): Promise<string>;
  assertCurrent(): Promise<void>;
};
const layouts = new AsyncLocalStorage<NativeFileLayout>();
export const currentNativeLayout = () => layouts.getStore();
export async function withNativeLayout<T>(
  layout: NativeFileLayout,
  fn: () => Promise<T>,
): Promise<T> {
  await layout.assertCurrent();
  return layouts.run(layout, fn);
}
/** Logical application filenames address the selected originals. No aliases are written to disk. */
export function nativeProjectPath(directory: string, ...parts: string[]): string {
  const candidate = resolve(directory, ...parts),
    layout = layouts.getStore();
  if (!layout || resolve(directory) !== layout.directory) return candidate;
  if (candidate === layout.cacheDirectory || candidate.startsWith(layout.cacheDirectory + sep))
    return candidate;
  const path = relative(layout.directory, candidate).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("..")) return candidate;
  const mapped = layout.files[path];
  if (mapped) return join(layout.directory, mapped);
  const first = path.split("/")[0]!;
  if (
    ["renders", "reports", "exports", "placement", ".fabdesk"].includes(first) ||
    ["comments.json", "NOTES.md"].includes(path)
  )
    return join(layout.cacheDirectory, path);
  return candidate;
}
export function nativeSessionKey(directory: string): string {
  return layouts.getStore()?.directory === resolve(directory)
    ? nativeProjectPath(directory, "board.kicad_pcb")
    : directory;
}

export function withoutNativeLayout<T>(fn: () => Promise<T>): Promise<T> {
  return layouts.exit(fn);
}
