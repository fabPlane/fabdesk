/**
 * Remote access: bind the daemon's second listener and pair a phone with it.
 *
 * Unlike the rest of Settings this section applies immediately rather than through the shared
 * draft/Save footer — a pairing code is live for three minutes, so a half-saved toggle would be
 * confusing, and the listener state the core reports is the truth worth showing.
 */
import type { CoreEndpoint, Device, EndpointKind, PairStartResult, RemoteStatus, Settings, TailscaleState } from "@fabdesk/protocol";
import { ENDPOINT_KIND_ORDER, REMOTE_DEFAULT_PORT, endpointBaseUrl, endpointScheme } from "@fabdesk/protocol";
import { useCoreClient, useDevices, usePatchSettings, useRemoteState, useSettings } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, EmptyState, Input, Select, Spinner } from "../components/ui";
import { qrSvg } from "./qr";

type RemoteSetting = Settings["remote"];
const DEFAULT_SETTING: RemoteSetting = { enabled: false, host: "0.0.0.0", port: REMOTE_DEFAULT_PORT };

/** The MagicDNS name when the daemon knows one (the IP stays in the tooltip); `https://name` for a served endpoint. */
export function endpointLabel(e: CoreEndpoint): string {
  if (endpointScheme(e) === "https") return endpointBaseUrl(e);
  return `${e.hostname ?? e.host}:${e.port}`;
}

const KIND_LABEL: Record<EndpointKind, string> = {
  "tailscale-https": "Tailscale HTTPS",
  tailscale: "Tailscale",
  lan: "LAN",
  other: "Other",
  loopback: "This machine only",
};

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** The daemon's `{ error }` body when there is one; a `CoreHttpError` message is the raw response text. */
export function daemonError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  try {
    const body = JSON.parse(message) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return message;
}

/** Why a phone would not reach the listener as configured, or null when it plausibly would. */
export function unreachableReason(setting: Pick<RemoteSetting, "host">, endpoints: CoreEndpoint[]): string | null {
  // `tailscale serve` reaches a loopback bind from the tailnet, so a served name makes any bind reachable.
  if (endpoints.some((e) => e.kind === "tailscale-https")) return null;
  if (/^(127\.|localhost$|::1$)/i.test(setting.host))
    return `Remote access is bound to ${setting.host}, which only this machine can reach. Phones cannot connect — set the host to 0.0.0.0 (all interfaces) or to this machine's tailnet or LAN address.`;
  if (endpoints.length === 0) return "No network address found — is this machine on a tailnet or LAN? A phone has nothing to connect to.";
  if (endpoints.every((e) => e.kind === "loopback")) return "The only address on offer is loopback, which phones cannot reach.";
  return null;
}

export function RemoteSection() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const settings = useSettings();
  const patch = usePatchSettings();
  const remote = useRemoteState();
  const devices = useDevices();
  const [pairing, setPairing] = useState<PairStartResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setting = settings.data?.remote ?? DEFAULT_SETTING;
  const [port, setPort] = useState(String(setting.port));
  useEffect(() => setPort(String(setting.port)), [setting.port]);
  // `remoteState()` predates the `endpoints` field; the daemon has sent it since endpoint kinds landed.
  const status = remote.data as RemoteStatus | undefined;
  const endpoints = useMemo(() => status?.endpoints ?? [], [status?.endpoints]);

  const applyRemote = (next: Partial<RemoteSetting>) => {
    setError(null);
    patch.mutate(
      { remote: { ...setting, ...next } },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ["remote"] }) },
    );
  };
  // Daemon-wide kill switch for push (docs/mobile-notifications.md §4.1); each phone also has its own prefs.
  const notificationsEnabled = settings.data?.notifications?.enabled ?? true;
  const applyNotifications = (enabled: boolean) => {
    setError(null);
    patch.mutate({ notifications: { enabled } });
  };

  const startPairing = async () => {
    setError(null);
    try {
      setPairing(await client.startPairing());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closePairing = () => {
    setPairing(null);
    void client.cancelPairing().catch(() => {});
  };

  // `tailscale serve` on the daemon's machine: the response is the new remote status, so it goes
  // straight into the cache rather than waiting for a refetch. Failures carry the CLI's stderr.
  const [servePending, setServePending] = useState(false);
  const setTailscaleServe = async (enabled: boolean) => {
    setError(null);
    setServePending(true);
    try {
      const next = await client.request<RemoteStatus>("/v1/remote/tailscale-serve", { method: "POST", json: { enabled } });
      qc.setQueryData(["remote"], next);
    } catch (e) {
      setError(daemonError(e));
    } finally {
      setServePending(false);
    }
  };

  const bound = remote.data?.enabled ? `${remote.data.host}:${remote.data.port}` : null;
  const warning = unreachableReason(setting, endpoints);
  // Only kinds this machine actually has are offered; picking an absent one would change nothing.
  const kindsOnOffer = ENDPOINT_KIND_ORDER.filter((k) => k !== "loopback" && endpoints.some((e) => e.kind === k));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">Remote access</span>
          {bound ? <Badge tone="success">listening on {bound}</Badge> : <Badge>off</Badge>}
        </div>
        <p className="mb-3 text-xs text-muted">
          Lets the fabPlane phone app reach this machine. Intended for a Tailscale tailnet or a trusted LAN — the
          connection is not encrypted on its own, so do not forward this port to the internet. Paired phones can do
          everything the desktop can.
        </p>
        <label className="flex items-center gap-2 py-1.5 text-xs">
          <input
            type="checkbox"
            checked={setting.enabled}
            disabled={patch.isPending}
            onChange={(e) => applyRemote({ enabled: e.target.checked })}
          />
          <span className="font-medium">Allow phones to connect</span>
        </label>
        <label className="flex items-start gap-2 py-1.5 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={notificationsEnabled}
            disabled={patch.isPending}
            onChange={(e) => applyNotifications(e.target.checked)}
          />
          <span>
            <span className="font-medium">Send notifications to paired phones</span>
            <span className="block text-[11px] text-muted">
              When a run finishes, fails or needs you and the phone is not connected. Goes through your fabPlane
              account; each phone chooses what it wants to hear about.
            </span>
          </span>
        </label>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3 py-1.5 text-xs">
          <span>
            <span className="font-medium">Port</span>
            <span className="block text-[11px] text-muted">Default {REMOTE_DEFAULT_PORT}</span>
          </span>
          <Input
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => {
              const n = Number(port);
              if (Number.isInteger(n) && n > 0 && n < 65536 && n !== setting.port) applyRemote({ port: n });
              else setPort(String(setting.port));
            }}
          />
        </label>
        <label className="grid grid-cols-[180px_1fr] items-center gap-3 py-1.5 text-xs">
          <span>
            <span className="font-medium">Preferred address</span>
            <span className="block text-[11px] text-muted">Listed first in the pairing code</span>
          </span>
          <Select
            value={setting.preferredEndpointKind ?? ""}
            disabled={patch.isPending || kindsOnOffer.length === 0}
            onChange={(e) => applyRemote({ preferredEndpointKind: (e.target.value || null) as EndpointKind | null })}
          >
            <option value="">Automatic (Tailscale HTTPS, then Tailscale, then LAN)</option>
            {kindsOnOffer.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </label>
        {status?.tailscale !== undefined && (
          <TailscaleRow tailscale={status.tailscale} pending={servePending || patch.isPending} onChange={(enabled) => void setTailscaleServe(enabled)} />
        )}
        <div className="mt-2">
          <div className="mb-1 text-xs font-medium">Reachable at</div>
          {remote.isLoading ? (
            <Spinner />
          ) : (
            <EndpointList
              endpoints={endpoints}
              onMakeDefault={(kind) => applyRemote({ preferredEndpointKind: kind })}
              current={setting.preferredEndpointKind}
            />
          )}
        </div>
        {warning && <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{warning}</div>}
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        {patch.isError && <div className="mt-2 text-xs text-danger">{(patch.error as Error).message}</div>}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">Paired devices</span>
          <Button variant="primary" onClick={() => void startPairing()} disabled={!bound}>
            Pair a device
          </Button>
        </div>
        {!bound && <div className="mb-2 text-xs text-muted">Turn remote access on to pair a phone.</div>}
        {devices.isLoading ? (
          <Spinner />
        ) : (devices.data ?? []).length === 0 ? (
          <EmptyState title="No devices yet">Pair a phone to see your projects and chats from it.</EmptyState>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {(devices.data ?? []).map((d: Device) => (
                <tr key={d.id} className="border-b border-border/60">
                  <td className="py-1.5 pr-2">{d.label}</td>
                  <td className="py-1.5 pr-2 text-muted">{d.platform}</td>
                  <td className="py-1.5 pr-2 text-muted">seen {relative(d.lastSeenAt)}</td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="danger"
                      onClick={() => {
                        void client.revokeDevice(d.id).then(() => qc.invalidateQueries({ queryKey: ["devices"] }));
                      }}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pairing && <PairingDialog pairing={pairing} setting={setting} onClose={closePairing} />}
    </div>
  );
}

/**
 * Front the listener with `tailscale serve` on 443. With it on, phones get a MagicDNS name over
 * TLS the tailnet vouches for — the one address that needs no cleartext exception on iOS.
 * `null` means the daemon found no Tailscale CLI, so there is nothing to set up.
 */
function TailscaleRow({ tailscale, pending, onChange }: { tailscale: TailscaleState | null; pending: boolean; onChange: (enabled: boolean) => void }) {
  const served = tailscale?.serve ?? null;
  let detail: string;
  if (!tailscale) detail = "Tailscale is not installed on this machine.";
  else if (!tailscale.dnsName) detail = tailscale.ip ? "MagicDNS is off for this tailnet, so there is no name to issue a certificate for." : "Tailscale is not connected.";
  else if (served) detail = `https://${tailscale.dnsName}${served.port === 443 ? "" : `:${served.port}`} — reachable from any device on the tailnet, with a certificate it already trusts.`;
  else if (!tailscale.httpsEnabled) detail = `Runs \`tailscale serve\` for ${tailscale.dnsName}. The tailnet's HTTPS certificates feature looks off — turn it on in the Tailscale admin console under DNS first.`;
  else detail = `Runs \`tailscale serve\` so phones reach ${tailscale.dnsName} over HTTPS.`;
  const canSetup = Boolean(tailscale?.dnsName);
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-3 py-1.5 text-xs">
      <span>
        <span className="font-medium">Tailscale HTTPS</span>
        <span className="block text-[11px] text-muted">TLS via `tailscale serve`</span>
      </span>
      <span className="flex items-center gap-2">
        {served ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}
        <span className="flex-1 text-[11px] text-muted">{detail}</span>
        {served ? (
          <Button size="sm" disabled={pending} onClick={() => onChange(false)}>
            Turn off
          </Button>
        ) : (
          canSetup && (
            <Button size="sm" variant="primary" disabled={pending} onClick={() => onChange(true)}>
              Set up
            </Button>
          )
        )}
      </span>
    </div>
  );
}

/**
 * The default endpoint, then "+N more" folding the rest (grouped by kind). `onMakeDefault` makes
 * a row's kind the preferred one; it is omitted where the list is only informational.
 */
function EndpointList({
  endpoints,
  current,
  onMakeDefault,
}: {
  endpoints: CoreEndpoint[];
  current?: EndpointKind | null | undefined;
  onMakeDefault?: (kind: EndpointKind) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const primary = endpoints.find((e) => e.default) ?? endpoints[0];
  if (!primary) return <div className="text-xs text-muted">No network address found.</div>;
  const rest = endpoints.filter((e) => e !== primary);
  const row = (e: CoreEndpoint) => (
    <div key={endpointLabel(e)} className="flex items-center gap-2 py-0.5 text-xs">
      <span className="font-mono" title={e.hostname && e.hostname !== e.host ? e.host : undefined}>
        {endpointLabel(e)}
      </span>
      <Badge tone={e.kind === "loopback" ? "warning" : e.default ? "accent" : "neutral"} {...(e.iface ? { title: e.iface } : {})}>
        {KIND_LABEL[e.kind]}
      </Badge>
      {e.default && <span className="text-[11px] text-muted">default</span>}
      {onMakeDefault && !e.default && e.kind !== "loopback" && e.kind !== current && (
        <Button size="sm" variant="ghost" onClick={() => onMakeDefault(e.kind)}>
          Make default
        </Button>
      )}
    </div>
  );
  return (
    <div className="rounded-md bg-panel-2 px-2 py-1">
      {row(primary)}
      {rest.length > 0 &&
        (expanded ? (
          <>
            {rest.map(row)}
            <button type="button" className="py-0.5 text-[11px] text-muted hover:text-fg" onClick={() => setExpanded(false)}>
              Show fewer
            </button>
          </>
        ) : (
          <button type="button" className="py-0.5 text-[11px] text-muted hover:text-fg" onClick={() => setExpanded(true)}>
            +{rest.length} more
          </button>
        ))}
    </div>
  );
}

function PairingDialog({ pairing, setting, onClose }: { pairing: PairStartResult; setting: RemoteSetting; onClose: () => void }) {
  const qc = useQueryClient();
  const client = useCoreClient();
  const [remaining, setRemaining] = useState(() => Date.parse(pairing.expiresAt) - Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const svg = useMemo(() => qrSvg(pairing.url), [pairing.url]);
  const warning = unreachableReason(setting, pairing.endpoints);

  useEffect(() => {
    const t = setInterval(() => setRemaining(Date.parse(pairing.expiresAt) - Date.now()), 500);
    return () => clearInterval(t);
  }, [pairing.expiresAt]);

  // The phone's claim lands on the core, not here, so watch the bus for it directly. The app's
  // shared stream does not carry `device.*` into any cache, and this dialog is the only listener.
  useEffect(() => {
    const sub = client.subscribe(["device.*"], (event) => {
      if (event.topic !== "device.paired") return;
      setPaired(event.label);
      void qc.invalidateQueries({ queryKey: ["devices"] });
    });
    return () => sub.close();
  }, [client, qc]);

  const expired = remaining <= 0;
  const seconds = Math.max(0, Math.ceil(remaining / 1000));

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(pairing.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied: the link is still visible in the QR */
    }
  };

  return (
    <Dialog open onClose={onClose} title="Pair a device" className="w-[460px]">
      {paired ? (
        <div className="space-y-3 py-6 text-center">
          <div className="text-sm font-medium">{paired} is paired</div>
          <p className="text-xs text-muted">It can now reach this machine while remote access is on.</p>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            In the fabPlane app on your phone, tap <span className="font-medium">Scan</span> and point it at this code,
            or send it the link.
          </p>
          <div
            className={expired ? "mx-auto w-[220px] opacity-30" : "mx-auto w-[220px]"}
            // The QR is generated locally from the pairing payload; no markup comes from outside.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <div className="text-center">
            <div className="font-mono text-lg tracking-[0.25em]">{pairing.code}</div>
            <div className="text-[11px] text-muted">
              {expired ? "This code has expired." : `Expires in ${seconds}s`}
            </div>
            <Button size="sm" className="mt-2" onClick={() => void copyLink()} disabled={expired}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <div className="text-[11px] text-muted">
            <div className="mb-1 font-medium text-fg">Reachable at</div>
            <EndpointList endpoints={pairing.endpoints} />
          </div>
          {warning && <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{warning}</div>}
        </div>
      )}
    </Dialog>
  );
}
