import type { RouterId } from "@fabdesk/protocol";

import { CapacityAutorouterAdapter } from "./adapters/capacity";
import type { RouterAdapter, RouterProbe } from "./types";

/** Compile-time channel, when the bundler defines it (`--define FABDESK_CHANNEL='"internal"'`). */
declare const FABDESK_CHANNEL: string | undefined;

/**
 * The internal adapter module name, kept out of a static `import()` on purpose: a literal would
 * let bundlers (and the public `tsc` run) follow it into vendor/js_autorouter, which public
 * checkouts do not have. Internal builds bundle the package by their own entry or mark it external.
 */
const FREEROUTING_MODULE = ["@fabdesk", "router-freerouting"].join("/");

export function isInternalChannel(): boolean {
  if (typeof FABDESK_CHANNEL !== "undefined" && FABDESK_CHANNEL === "internal") {
    return true;
  }
  return process.env["FABDESK_CHANNEL"] === "internal";
}

export interface LoadAdapterOptions {
  /**
   * Whether the internal channel is active; defaults to `isInternalChannel()`. The worker takes
   * it from its host: a Bun Worker sees the OS environment, not `process.env` edits made in the
   * host after startup, so the host's own verdict is forwarded with each route command.
   */
  internal?: boolean | undefined;
}

let freeroutingLoad: Promise<RouterAdapter | undefined> | undefined;

/** The js_autorouter adapter, or undefined outside the internal channel / without the submodule. */
export function loadFreeroutingAdapter(
  options: LoadAdapterOptions = {},
): Promise<RouterAdapter | undefined> {
  if (!(options.internal ?? isInternalChannel())) {
    return Promise.resolve(undefined);
  }
  freeroutingLoad ??= importFreerouting();
  return freeroutingLoad;
}

async function importFreerouting(): Promise<RouterAdapter | undefined> {
  try {
    const mod = (await import(FREEROUTING_MODULE)) as {
      default?: new () => RouterAdapter;
      FreeroutingAdapter?: new () => RouterAdapter;
    };
    const Adapter = mod.default ?? mod.FreeroutingAdapter;
    return Adapter === undefined ? undefined : new Adapter();
  } catch {
    return undefined;
  }
}

export async function loadAdapter(
  id: RouterId,
  options: LoadAdapterOptions = {},
): Promise<RouterAdapter | undefined> {
  switch (id) {
    case "capacity":
      return new CapacityAutorouterAdapter();
    case "freerouting":
      return loadFreeroutingAdapter(options);
  }
}

/** Capacity always; freerouting only when the internal adapter loads. */
export async function availableRouters(): Promise<RouterProbe[]> {
  const capacity = await new CapacityAutorouterAdapter().probe();
  const freerouting = await loadFreeroutingAdapter();
  const freeroutingProbe: RouterProbe =
    freerouting !== undefined
      ? await freerouting.probe()
      : {
          id: "freerouting",
          present: false,
          ready: false,
          version: "",
          detail: isInternalChannel()
            ? "@fabdesk/router-freerouting could not be loaded (vendor/js_autorouter submodule missing?)"
            : "internal channel only",
        };
  return [capacity, freeroutingProbe];
}
