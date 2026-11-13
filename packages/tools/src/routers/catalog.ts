import type { RouterCatalogId } from "@fabdesk/protocol";
import { KRT_BYTES, KRT_HOMEPAGE, KRT_SHA256, KRT_URL, KRT_VERSION } from "./krt";
import {
  defaultTraceMakerBinaryRelease,
  type TraceMakerBinaryRelease,
} from "./tracemaker-release";

export type RouterArtifactFormat = "jar" | "zip" | "tar.gz" | "tar.bz2" | "file";

export type RouterArtifact = {
  url: string;
  sha256: string;
  /** Advertised size when known; downloads also have a hard max. */
  bytes?: number;
  filename: string;
  format: RouterArtifactFormat;
  /** Path relative to the extracted tree, or the saved filename for `jar`/`file`. */
  executable?: string;
  /** Extract the archive into this subdirectory of the install (KRT's zip becomes `<root>/src`). */
  subdir?: string;
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
  /** `engine`: run by the board workflow, not offered as a `route_run` router. Omitted means router. */
  kind?: "router" | "engine";
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
 * Install prefers a platform binary from the weekly `tracemaker-latest` manifest
 * (`FABDESK_TRACEMAKER_MANIFEST_URL` / Settings `tracemakerManifestUrl`, defaulting
 * to https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json).
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

/**
 * atlc 4.6.1 (GPL-2.0-or-later), the finite-difference transmission-line solver `board_review section` runs. Upstream
 * publishes source only; Install downloads Debian's pristine copy of the upstream tarball and builds `src/atlc` with the
 * machine's C compiler (`sh configure && make`, single-threaded like Debian's package). An `atlc` on PATH (Debian/Ubuntu
 * package `atlc`) or ATLC_BIN is used instead when present.
 */
export const ATLC_VERSION = "4.6.1";
export const ATLC_SHA256 = "0ad8f9bb2a9c59ed452ffd8fdbad85a53d0c3022e69d479caa4ab9c0a6841321";
export const ATLC_BYTES = 1_784_110;
export const ATLC_URL = "https://deb.debian.org/debian/pool/main/a/atlc/atlc_4.6.1.orig.tar.bz2";
export const ATLC_HOMEPAGE = "https://atlc.sourceforge.net";

const STRENGTHS = {
  fab_router: [
    "Bundled router when the active PCB backend exposes the engine",
    "Best default for automatic selective reroutes and fast iteration",
    "No separate download in a complete desktop bundle; Freerouting fallback when available",
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
  krt: [
    "Placer and router behind board_route's place, rank and route stages",
    "Runs every last-mile router, rip and nudge step, and the `why` forensics",
    "Rust A* core with differential pairs, fanout and plane routing",
  ],
  atlc: [
    "Finite-difference 2D cross-section impedance for board_review section (Zdiff, Zo, Zodd/Zeven)",
    "Arbitrary conductor and dielectric shapes: etched trapezoids, soldermask, stripline and microstrip",
    "The solver behind the toolkit's stack106 USB 90 / LVDS 100 ohm proof",
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
        "Bundled fabPlane router on the PCB backend. Runtime availability is checked separately from installation.",
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
    {
      id: "krt",
      displayName: "KiCadRoutingTools",
      description:
        "Python + Rust placer and router (MIT) the board workflow runs. Install downloads the pinned release and sets up a private, hash-locked Python venv (numpy, scipy, shapely); uv and CPython are fetched when the machine has neither. Board tools install it on first use.",
      strengths: [...STRENGTHS.krt],
      license: "MIT",
      version: KRT_VERSION,
      homepage: KRT_HOMEPAGE,
      install: "download",
      kind: "engine",
      artifact: {
        url: env["FABDESK_KRT_URL"] ?? KRT_URL,
        sha256: env["FABDESK_KRT_SHA256"] ?? KRT_SHA256,
        ...(env["FABDESK_KRT_URL"] ? {} : { bytes: KRT_BYTES }),
        filename: `KiCadRoutingTools-${KRT_VERSION}.zip`,
        format: "zip",
        subdir: "src",
      },
    },
    {
      id: "atlc",
      displayName: "atlc",
      description:
        "Finite-difference transmission-line calculator (GPL-2.0-or-later) for board_review section. Install downloads the pinned 4.6.1 source and builds it with the machine's C compiler; an atlc on PATH or ATLC_BIN is used instead when present.",
      strengths: [...STRENGTHS.atlc],
      license: "GPL-2.0-or-later",
      version: ATLC_VERSION,
      homepage: ATLC_HOMEPAGE,
      install: "download",
      kind: "engine",
      artifact: {
        url: env["FABDESK_ATLC_URL"] ?? ATLC_URL,
        sha256: env["FABDESK_ATLC_SHA256"] ?? ATLC_SHA256,
        ...(env["FABDESK_ATLC_URL"] ? {} : { bytes: ATLC_BYTES }),
        filename: `atlc-${ATLC_VERSION}.tar.bz2`,
        format: "tar.bz2",
        executable: `atlc-${ATLC_VERSION}/src/atlc`,
      },
    },
  ];
}
