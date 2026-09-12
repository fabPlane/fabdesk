/**
 * `fabdesk-core pair`: mint a pairing code on the running daemon and print it as a terminal QR,
 * the link, and the typeable code — the desktop's dialog for an SSH session. Waits for the phone
 * to claim it (the daemon's `device.paired` event) unless told not to.
 */
import {
  endpointBaseUrl,
  type CoreEndpoint,
  type PairStartResult,
  type RemoteStatus,
} from "@fabdesk/protocol";
import { qrTerminal } from "@fabdesk/qr";
import type { DaemonClient, Io } from "./daemon";

export type PairArgs = { json: boolean; wait: boolean; invert: boolean };

export function parsePairArgs(flags: Record<string, unknown>): PairArgs {
  return {
    json: flags["json"] === true,
    wait: flags["no-wait"] !== true,
    invert: flags["invert"] === true,
  };
}

const KIND_LABEL: Record<CoreEndpoint["kind"], string> = {
  "tailscale-https": "Tailscale HTTPS",
  tailscale: "Tailscale",
  lan: "LAN",
  other: "other",
  loopback: "this machine only",
  relay: "relay",
};

/** Everything but the QR itself: the human-readable part of the pairing screen. */
export function formatPairing(result: PairStartResult, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((Date.parse(result.expiresAt) - now) / 1000));
  const lines = [
    `Pair a phone with ${result.coreName}: in the fabPlane app tap Scan and point it at the code above,`,
    `or open the link on the phone.`,
    ``,
    `  ${result.url}`,
    ``,
    `  Code: ${result.code}   (expires in ${seconds}s)`,
    ``,
    `Reachable at:`,
    ...result.endpoints.map(
      (e) =>
        `  ${endpointBaseUrl(e).padEnd(44)} ${KIND_LABEL[e.kind]}${e.default ? "  (default)" : ""}`,
    ),
  ];
  if (result.endpoints.every((e) => e.kind === "loopback"))
    lines.push(
      ``,
      `Warning: only a loopback address is on offer; a phone cannot reach it. Bind remote access to 0.0.0.0 or set up Tailscale HTTPS.`,
    );
  return lines.join("\n") + "\n";
}

/**
 * Reads the daemon's SSE stream until a `device.paired` arrives or `signal` fires. The stream is
 * `id:`/`data:` lines separated by blank lines; only `data:` matters here.
 */
export async function waitForPaired(
  client: DaemonClient,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ deviceId: string; label: string } | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${client.baseUrl}/events?topics=device.*`, {
      headers: { authorization: `Bearer ${client.token}` },
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as {
            topic?: string;
            deviceId?: string;
            label?: string;
          };
          if (event.topic === "device.paired" && event.deviceId)
            return { deviceId: event.deviceId, label: event.label ?? event.deviceId };
        } catch {
          /* a partial or foreign line; keep reading */
        }
      }
    }
  } catch {
    return null; // aborted (expired) or the daemon went away
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function pairCommand(client: DaemonClient, args: PairArgs, io: Io): Promise<number> {
  const remote = await client.request<RemoteStatus>("/v1/remote");
  if (!remote.enabled) {
    io.err(
      `Remote access is off, so a phone would have nothing to connect to. Turn it on in Settings › Remote access, or restart with: fabdesk-core serve --remote\n`,
    );
    return 1;
  }
  const result = await client.request<PairStartResult>("/v1/devices/pair/start", {
    method: "POST",
  });
  if (args.json) {
    io.out(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  io.out("\n" + qrTerminal(result.url, { invert: args.invert }) + "\n\n");
  io.err(formatPairing(result));
  if (!args.wait) return 0;

  io.err(`\nWaiting for a phone… (Ctrl-C to stop)\n`);
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    Math.max(0, Date.parse(result.expiresAt) - Date.now()),
  );
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  try {
    const paired = await waitForPaired(client, abort.signal);
    if (paired) {
      io.err(
        `Paired: ${paired.label} (${paired.deviceId}). It can now reach this machine while remote access is on.\n`,
      );
      return 0;
    }
    io.err(
      abort.signal.aborted
        ? `The code expired or the wait was interrupted; run pair again for a fresh one.\n`
        : `Lost the daemon's event stream before a phone paired.\n`,
    );
    await client.request("/v1/devices/pair/cancel", { method: "POST" }).catch(() => {});
    return 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
  }
}
