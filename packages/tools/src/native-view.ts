import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { currentNativeLayout } from "./native-layout";
import { jailPath, writeJson } from "./fs";
import { NativeRevisionConflict } from "./registry";
export type NativeViewKind = "pcb" | "schematic" | "3d";
export const nativeViewRevision = () => currentNativeLayout()?.captureRevision();
export async function assertNativeViewRevision(revision: string | undefined) {
  const layout = currentNativeLayout();
  if (!layout || !revision) return;
  await layout.assertCurrent();
  if ((await layout.captureRevision()) !== revision)
    throw new NativeRevisionConflict(
      "Native design changed while rendering. Previous content is retained; retry after saved inputs settle.",
    );
}
export async function recordNativeView(
  kind: NativeViewKind,
  artifact: string,
  revision: string | undefined,
) {
  const layout = currentNativeLayout();
  if (!layout || !revision) return;
  await assertNativeViewRevision(revision);
  const artifactSha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  await writeJson(await jailPath(layout.directory, `.fabdesk/view-bindings/${kind}.json`), {
    source: layout.context.sourcePath,
    sourceRevision: revision,
    artifactSha256,
  });
}
export async function nativeViewBinding(kind: NativeViewKind, artifactSha256: string) {
  const layout = currentNativeLayout();
  if (!layout) return { status: "unknown" };
  try {
    const receipt = JSON.parse(
      await readFile(
        await jailPath(layout.directory, `.fabdesk/view-bindings/${kind}.json`),
        "utf8",
      ),
    );
    if (
      receipt.source !== layout.context.sourcePath ||
      receipt.artifactSha256 !== artifactSha256 ||
      typeof receipt.sourceRevision !== "string"
    )
      return { status: "unknown" };
    return {
      ...receipt,
      status: (await layout.captureRevision()) === receipt.sourceRevision ? "current" : "stale",
      checkedAt: new Date().toISOString(),
      dependencies:
        "saved native documents and reachable sheets; external component assets unverified",
    };
  } catch {
    return { status: "unknown" };
  }
}
