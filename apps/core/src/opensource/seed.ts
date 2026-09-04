import type { OpenCatalogEntry, OpenCatalogIndex } from "@fabdesk/protocol";

function github(
  owner: string,
  repo: string,
  name: string,
  description: string,
  license: string,
  tags: string[],
  extras: { ownerSlug?: string; slug?: string } = {},
): OpenCatalogEntry {
  const ownerSlug = extras.ownerSlug ?? owner.toLowerCase();
  const slug = extras.slug ?? repo.toLowerCase().replace(/_/g, "-");
  const url = `https://github.com/${owner}/${repo}`;
  return {
    id: `${ownerSlug}/${slug}`,
    visibility: "public",
    ownerSlug,
    slug,
    name,
    description,
    cloneUrl: `${url}.git`,
    homepageUrl: url,
    previewUrl: `https://opengraph.github.com/repo/${owner}/${repo}`,
    tags,
    source: { provider: "github", owner, repository: repo, url, license },
  };
}

/** Offline fallback matching fabplane.com's curated top-20 PCB catalog. */
export const OPEN_CATALOG_SEED: OpenCatalogEntry[] = [
  {
    id: "tensorfleet/koyomi-lvds-hat",
    visibility: "public",
    ownerSlug: "tensorfleet",
    slug: "koyomi-lvds-hat",
    name: "Koyomi LVDS HAT",
    description: "Raspberry Pi RGB/DPI-to-LVDS board for the Sony VAIO P 1600 × 768 panel.",
    cloneUrl: "https://github.com/TensorFleet/koyomi-lvds-hat.git",
    homepageUrl: "https://github.com/TensorFleet/koyomi-lvds-hat",
    previewUrl:
      "https://raw.githubusercontent.com/TensorFleet/koyomi-lvds-hat/main/fab/r2.6-compact-rgb-production-jlc-candidate/renders/perspective.png",
    heroUrl:
      "https://raw.githubusercontent.com/TensorFleet/koyomi-lvds-hat/main/fab/r2.6-compact-rgb-production-jlc-candidate/renders/perspective.png",
    tags: ["KiCad", "Raspberry Pi", "LVDS"],
    source: {
      provider: "github",
      owner: "TensorFleet",
      repository: "koyomi-lvds-hat",
      url: "https://github.com/TensorFleet/koyomi-lvds-hat",
      license: "CERN-OHL-S-2.0",
    },
  },
  github("greatscottgadgets", "hackrf", "HackRF One", "Wideband software-defined radio with published hardware.", "GPL-2.0", ["SDR", "RF"]),
  github("greatscottgadgets", "greatfet", "GreatFET One", "Open USB interface for embedded research.", "BSD-3-Clause", ["USB", "Debug"]),
  github("blackmagic-debug", "blackmagic", "Black Magic Probe", "ARM Cortex debugger with published probe hardware.", "GPL-3.0", ["Debug", "ARM"]),
  github("DangerousPrototypes", "Bus_Pirate", "Bus Pirate", "Universal serial bus pirate with published PCB source.", "CC-BY-SA-3.0", ["Debug", "SPI"], { slug: "bus-pirate" }),
  github("frameworkcomputer", "inputmodule", "Framework Input Module", "Framework Laptop 16 LED-matrix and input modules.", "MIT", ["Framework", "RP2040"]),
  github("keyboardio", "Atreus", "Keyboardio Atreus", "Compact 42-key keyboard with published PCB files.", "GPL-3.0", ["Keyboard", "KiCad"]),
  github("pierrechevalier83", "ferris", "Ferris keyboard", "34-key split keyboard with KiCad sources.", "CERN-OHL-P-2.0", ["Keyboard", "Split"]),
  github("betrusted-io", "precursor", "Precursor", "Inspectable open mobile hardware with published PCB files.", "CERN-OHL-S-2.0", ["FPGA", "Mobile"]),
  github("mntmn", "reform", "MNT Reform", "Open modular laptop motherboard and keyboard.", "CERN-OHL-S-2.0", ["Laptop", "KiCad"]),
  github("adafruit", "Adafruit-Feather-RP2040-PCB", "Adafruit Feather RP2040", "Open Feather-format RP2040 development board.", "CC-BY-SA-3.0", ["RP2040", "Feather"], { slug: "adafruit-feather-rp2040-pcb" }),
  github("sparkfun", "Pro_Micro", "SparkFun Pro Micro", "Classic ATmega32U4 Pro Micro with published board files.", "CC-BY-SA-3.0", ["AVR", "USB"], { slug: "pro-micro" }),
  github("Seeed-Studio", "OSHW-XIAO-Series", "Seeed XIAO series", "Open hardware files for the XIAO family.", "MIT", ["XIAO", "RP2040"], { ownerSlug: "seeed-studio", slug: "oshw-xiao-series" }),
  github("icebreaker-fpga", "icebreaker", "iCEBreaker FPGA", "Open iCE40 FPGA board for teaching and open toolchains.", "CERN-OHL-W-2.0", ["FPGA", "iCE40"]),
  github("GlasgowEmbedded", "glasgow", "Glasgow Interface Explorer", "Digital interface explorer with published FPGA hardware.", "0BSD", ["FPGA", "Debug"]),
  github("im-tomu", "fomu-hardware", "Fomu", "FPGA in a USB port — iCE40 board inside a USB-A connector.", "CERN-OHL-W-2.0", ["FPGA", "USB"], { slug: "fomu-hardware" }),
  github("flipperdevices", "flipperzero-hardware", "Flipper Zero hardware", "Published Flipper Zero hardware design files.", "LicenseRef-Flipper-Hardware", ["RFID", "Sub-GHz"], { slug: "flipperzero-hardware" }),
  github("OpenMV", "openmv", "OpenMV Cam", "Open machine-vision camera modules with published PCBs.", "MIT", ["Vision", "STM32"]),
  github("raspberrypi", "hats", "Raspberry Pi HATs", "Official HAT design resources for Raspberry Pi add-on boards.", "BSD-3-Clause", ["Raspberry Pi", "HAT"]),
  github("foostan", "crkbd", "Corne keyboard (crkbd)", "Popular 42-key split keyboard with published KiCad sources.", "MIT", ["Keyboard", "Split"]),
];

export function seedCatalogIndex(): OpenCatalogIndex {
  return { generatedAt: "2026-09-03T00:00:00.000Z", source: "seed", projects: OPEN_CATALOG_SEED };
}

export function filterCatalog(projects: readonly OpenCatalogEntry[], q?: string): OpenCatalogEntry[] {
  const needle = q?.trim().toLowerCase();
  if (!needle) return [...projects];
  return projects.filter((project) =>
    [project.id, project.name, project.slug, project.ownerSlug, project.description ?? "", ...(project.tags ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
