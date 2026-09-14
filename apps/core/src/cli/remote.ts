/**
 * `fabdesk-core serve --remote [--remote-host <addr>] [--remote-port <n>] [--relay auto|off]`:
 * turn the remote listener on for a headless daemon (and, with `--relay off`, keep it off the
 * fabplane.com relay). The setting is persisted before `serve()` starts, and
 * `serve()` applies it exactly as a Settings patch would — so the flags are a one-time edit of
 * the same `remote` setting, not a separate mode, and the next plain `serve` keeps it.
 *
 * They are `--remote-*` rather than `--host`/`--port`, which `serve` already uses for the
 * loopback listener Electron spawns it with.
 */
import { REMOTE_DEFAULT_PORT, Settings } from "@fabdesk/protocol";

export type RemoteFlags = Record<string, unknown>;

/** The `remote` setting patch the flags ask for, or null when none of them is present. Throws on a bad value. */
export function remoteSettingFromFlags(
  flags: RemoteFlags,
  current: Settings["remote"],
): Settings["remote"] | null {
  const wanted = flags["remote"] === true || flags["remote"] === "true" || flags["remote"] === "1";
  const host = typeof flags["remote-host"] === "string" ? flags["remote-host"] : undefined;
  const portRaw = typeof flags["remote-port"] === "string" ? flags["remote-port"] : undefined;
  const relayRaw = flags["relay"];
  let relay: Settings["remote"]["relay"];
  if (relayRaw !== undefined) {
    if (relayRaw !== "auto" && relayRaw !== "off")
      throw new Error(`--relay must be auto or off, got "${String(relayRaw)}"`);
    relay = relayRaw;
  }
  if (flags["remote"] === "false" || flags["remote"] === "0")
    return { ...current, enabled: false, ...(relay ? { relay } : {}) };
  if (!wanted && host === undefined && portRaw === undefined) {
    // `--relay` alone edits that one field; it does not switch remote access on.
    return relay ? { ...current, relay } : null;
  }
  let port = current.port;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        `--remote-port must be 1–65535 (default ${REMOTE_DEFAULT_PORT}), got "${portRaw}"`,
      );
  }
  if (host !== undefined && host.trim() === "")
    throw new Error("--remote-host cannot be empty; use 0.0.0.0 for every interface");
  return Settings.shape.remote.parse({
    ...current,
    enabled: true,
    ...(host !== undefined ? { host: host.trim() } : {}),
    port,
    ...(relay ? { relay } : {}),
  });
}

/** Writes the patch into the daemon's own settings store, which `serve()` reads at start. */
export async function persistRemoteFlags(
  dbPath: string,
  flags: RemoteFlags,
): Promise<Settings["remote"] | null> {
  const { Store } = await import("../db");
  const store = Store.open(dbPath);
  try {
    const next = remoteSettingFromFlags(flags, store.settings.get().remote);
    if (next) store.settings.patch({ remote: next });
    return next;
  } finally {
    store.close();
  }
}
