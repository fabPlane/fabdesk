/** `fabdesk-core devices list | revoke <id>`: the paired-phone table from Settings, for a headless box. */
import type { Device } from "@fabdesk/protocol";
import type { DaemonClient, Io } from "./daemon";

function age(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Fixed-width columns, header first; an empty list is one line saying so. */
export function formatDevices(devices: Device[], now = Date.now()): string {
  if (devices.length === 0) return "No paired devices.\n";
  const rows = devices.map((d) => [
    d.id,
    d.label,
    d.platform,
    d.createdAt.slice(0, 10),
    age(d.lastSeenAt, now),
  ]);
  const header = ["ID", "LABEL", "PLATFORM", "PAIRED", "LAST SEEN"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n") + "\n";
}

export type DevicesArgs = { sub: string | undefined; id: string | undefined; json: boolean };

export function parseDevicesArgs(
  positional: string[],
  flags: Record<string, unknown>,
): DevicesArgs {
  return { sub: positional[1], id: positional[2], json: flags["json"] === true };
}

export const DEVICES_USAGE = "usage: fabdesk-core devices list [--json] | devices revoke <id>\n";

export async function devicesCommand(
  client: DaemonClient,
  args: DevicesArgs,
  io: Io,
): Promise<number> {
  switch (args.sub) {
    case "list":
    case undefined: {
      const devices = await client.request<Device[]>("/v1/devices");
      io.out(args.json ? JSON.stringify(devices, null, 2) + "\n" : formatDevices(devices));
      return 0;
    }
    case "revoke": {
      if (!args.id) {
        io.err(DEVICES_USAGE);
        return 2;
      }
      // Devices are listed by id; a label is what a person remembers, so accept that too when unique.
      const devices = await client.request<Device[]>("/v1/devices");
      const matches = devices.filter((d) => d.id === args.id || d.label === args.id);
      if (matches.length === 0) {
        io.err(`No paired device with id or label "${args.id}".\n`);
        return 1;
      }
      if (matches.length > 1) {
        io.err(
          `"${args.id}" matches ${matches.length} devices; use the id:\n${formatDevices(matches)}`,
        );
        return 1;
      }
      const target = matches[0]!;
      await client.request(`/v1/devices/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      io.err(`Revoked ${target.label} (${target.id}). It can no longer reach this machine.\n`);
      return 0;
    }
    default:
      io.err(DEVICES_USAGE);
      return 2;
  }
}
