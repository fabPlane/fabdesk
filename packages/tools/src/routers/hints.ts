import type { RouterCatalogId, RouterSnapshot } from "@fabdesk/protocol";
import { ATLC_VERSION, TRACEMAKER_HOMEPAGE, TRACEMAKER_VERSION } from "./catalog";
import { KRT_VERSION } from "./krt";

export function installHintFor(
  id: RouterCatalogId,
  snapshot?: Pick<RouterSnapshot, "state" | "error" | "installHint">,
): string {
  if (snapshot?.installHint) return snapshot.installHint;
  if (id === "tracemaker") {
    return [
      "TraceMaker is not installed.",
      `Install it from Settings → Routers (downloads a weekly TensorFleet-built binary when one exists for this platform), or set TRACEMAKER_BIN.`,
      `GPL-3.0-or-later; binaries ship LICENSE + SOURCE.txt (pinned upstream commit). If no binary exists for this OS/arch, Install falls back to the v${TRACEMAKER_VERSION} source package (~21 MB) at ${TRACEMAKER_HOMEPAGE}.`,
      snapshot?.error ? `Last error: ${snapshot.error}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (id === "freerouting") {
    return [
      "Freerouting is not installed.",
      "Install it from Settings → Routers (downloads the GPL-3.0 JAR into the fabdesk data dir), or set FREEROUTING_JAR to an existing jar.",
      snapshot?.error ? `Last error: ${snapshot.error}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (id === "krt") {
    return [
      "KiCadRoutingTools is not installed.",
      `Board tools install it on first use; or install it from Settings → Routers → KiCadRoutingTools or board_engines (downloads the MIT v${KRT_VERSION} release, ~16 MB, and a private hash-locked Python with numpy, scipy and shapely; uv and CPython are fetched when the machine has neither), or set FABDESK_KRT_DIR to a build.`,
      snapshot?.error ? `Last error: ${snapshot.error}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (id === "atlc") {
    return [
      "atlc is not installed.",
      `board_review section installs it on first use; or install it from Settings → Routers → atlc or board_engines (downloads the GPL v${ATLC_VERSION} source, ~2 MB, and builds it with the machine's C compiler: cc and make are needed), or install your system's atlc package, or set ATLC_BIN.`,
      snapshot?.error ? `Last error: ${snapshot.error}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return `${id} is not available.`;
}

export function bundledHint(id: RouterCatalogId, path?: string): string {
  if (id === "fab_router") return "Bundled with fabdesk; always available on the PCB bridge.";
  if (id === "freerouting")
    return path
      ? `Bundled Freerouting runtime at ${path}.`
      : "Bundled Freerouting runtime is available.";
  return `${id} is bundled.`;
}
