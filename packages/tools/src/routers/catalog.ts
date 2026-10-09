import type { RouterCatalogId } from "@fabdesk/protocol";
import {
  defaultTraceMakerBinaryRelease,
  type TraceMakerBinaryRelease,
} from "./tracemaker-release";

export type RouterArtifactFormat = "jar" | "zip" | "tar.gz" | "file";

export type RouterArtifact = {
  url: string;
  sha256: string;
  /** Advertised size when known; downloads also have a hard max. */
  bytes?: number;
  filename: string;
  format: RouterArtifactFormat;
  /** Path relative to the extracted tree, or the saved filename for `jar`/`file`. */
  executable?: string;
};

export type RouterCatalogEntry = {
  id: RouterCatalogId;
  displayName: string;
  description: string;
  strengths: string[];
  license: string;
  version: string;
  homepage: string;
  install: "bundled" | "download";
  artifact?: RouterArtifact;
  /** Weekly TensorFleet-built binaries; Install prefers these over `artifact`. */
  binaryRelease?: TraceMakerBinaryRelease;
};

/** Freerouting 2.4.1 JAR (GPL-3.0), documented in fab_pcb `packages/router`. */
export const FREEROUTING_VERSION = "2.4.1";
export const FREEROUTING_SHA256 =
  "251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9";
export const FREEROUTING_URL = `https://github.com/freerouting/freerouting/releases/download/v${FREEROUTING_VERSION}/freerouting-${FREEROUTING_VERSION}.jar`;

/**
 * TraceMaker source-tarball fallback from the tagged GitHub release.
 * Measured 2026-10-09: v0.8.0 is 20,863,170 bytes (~19.9 MiB). Official upstream
 * binaries are not published (the v0.8.0 "zip" is an 8.7 KB KiCad plugin).
 * Install prefers a platform binary from TensorFleet/fabdesk `tracemaker-latest`
 * (see `.github/workflows/tracemaker-binaries.yml`) and uses this tarball only
 * when no binary exists for the current OS/arch, or when FABDESK_TRACEMAKER_URL
 * is set.
 */
export const TRACEMAKER_VERSION = "0.8.0";
export const TRACEMAKER_SHA256 =
  "1d77e994c5b44d51ff885c1a2081f61c3ee94f96d4136922bbb640f3f7904b68";
export const TRACEMAKER_BYTES = 20_863_170;
export const TRACEMAKER_URL =
  "https://github.com/DingoOz/TraceMaker/archive/refs/tags/v0.8.0.tar.gz";
export const TRACEMAKER_HOMEPAGE = "https://github.com/DingoOz/TraceMaker";

const STRENGTHS = {
  fab_router: [
    "Always available built-in router (bridge `js` / capacity autorouter)",
    "Best default for automatic selective reroutes and fast iteration",
    "No extra download; used as the Freerouting fallback",
  ],
  freerouting: [
    "Best simple-board routing quality in the team's comparison",
    "Strong completion on mid-size boards the JS router struggles with",
    "Specctra DSN/SES path already wired on the FabPlane PCB bridge",
  ],
  tracemaker: [
    "Best whole-board routing and dense-pad completion in the team's comparison",
    "Writes tracks and vias directly into `.kicad_pcb` (no DSN round-trip)",
    "Judged by KiCad DRC; optional GPU/Metal acceleration",
  ],
} as const;

export function defaultRouterCatalog(env: NodeJS.ProcessEnv = process.env): RouterCatalogEntry[] {
  const freeroutingUrl = env["FABDESK_FREEROUTING_URL"] ?? FREEROUTING_URL;
  const freeroutingSha = env["FABDESK_FREEROUTING_SHA256"] ?? FREEROUTING_SHA256;
  const tracemakerUrl = env["FABDESK_TRACEMAKER_URL"] ?? TRACEMAKER_URL;
  const tracemakerSha = env["FABDESK_TRACEMAKER_SHA256"] ?? TRACEMAKER_SHA256;
  const tracemakerBytes = env["FABDESK_TRACEMAKER_BYTES"]
    ? Number(env["FABDESK_TRACEMAKER_BYTES"])
    : TRACEMAKER_BYTES;
  const sourceOverride = Boolean(env["FABDESK_TRACEMAKER_URL"]?.trim());
  const binaryRelease = sourceOverride ? undefined : defaultTraceMakerBinaryRelease(env);
  return [
    {
      id: "fab_router",
      displayName: "fab_router",
      description:
        "Built-in FabPlane router on the PCB bridge. Always present; no install step.",
      strengths: [...STRENGTHS.fab_router],
      license: "TensorFleet (bundled with fabdesk)",
      version: "bundled",
      homepage: "https://github.com/TensorFleet/fabdesk",
      install: "bundled",
    },
    {
      id: "freerouting",
      displayName: "Freerouting",
      description:
        "Java Specctra autorouter. Bundled in packaged desktop builds; otherwise downloaded into the per-user fabdesk data dir.",
      strengths: [...STRENGTHS.freerouting],
      license: "GPL-3.0",
      version: FREEROUTING_VERSION,
      homepage: "https://github.com/freerouting/freerouting",
      install: "download",
      artifact: {
        url: freeroutingUrl,
        sha256: freeroutingSha,
        filename: `freerouting-${FREEROUTING_VERSION}.jar`,
        format: "jar",
      },
    },
    {
      id: "tracemaker",
      displayName: "TraceMaker",
      description:
        "Native KiCad autorouter (C++20, GPL-3.0-or-later). Install downloads a weekly TensorFleet-built binary when one exists for this OS/arch; otherwise the upstream source tarball.",
      strengths: [...STRENGTHS.tracemaker],
      license: "GPL-3.0-or-later",
      version: TRACEMAKER_VERSION,
      homepage: TRACEMAKER_HOMEPAGE,
      install: "download",
      ...(binaryRelease ? { binaryRelease } : {}),
      artifact: {
        url: tracemakerUrl,
        sha256: tracemakerSha,
        ...(Number.isFinite(tracemakerBytes) && tracemakerBytes > 0
          ? { bytes: tracemakerBytes }
          : {}),
        filename: `tracemaker-${TRACEMAKER_VERSION}.tar.gz`,
        format: "tar.gz",
        executable: "tracemaker",
      },
    },
  ];
}
