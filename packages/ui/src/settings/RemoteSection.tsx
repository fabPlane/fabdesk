/**
 * Remote access: bind the daemon's second listener and pair a phone with it.
 *
 * Unlike the rest of Settings this section applies immediately rather than through the shared
 * draft/Save footer — a pairing code is live for three minutes, so a half-saved toggle would be
 * confusing, and the listener state the core reports is the truth worth showing.
 */
import type { CoreEndpoint, Device, PairStartResult } from "@fabdesk/protocol";
import { REMOTE_DEFAULT_PORT } from "@fabdesk/protocol";
import { useCoreClient, useDevices, usePatchSettings, useRemoteState, useSettings } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, EmptyState, Input, Spinner } from "../components/ui";
import { qrSvg } from "./qr";

function endpointLabel(e: CoreEndpoint): string {
  return `${e.host}:${e.port}`;
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
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

  const setting = settings.data?.remote ?? { enabled: false, host: "0.0.0.0", port: REMOTE_DEFAULT_PORT };
  const [port, setPort] = useState(String(setting.port));
  useEffect(() => setPort(String(setting.port)), [setting.port]);

  const applyRemote = (next: Partial<typeof setting>) => {
    setError(null);
    patch.mutate(
      { remote: { ...setting, ...next } },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ["remote"] }) },
    );
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

  const bound = remote.data?.enabled ? `${remote.data.host}:${remote.data.port}` : null;

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

      {pairing && <PairingDialog pairing={pairing} onClose={closePairing} />}
    </div>
  );
}

function PairingDialog({ pairing, onClose }: { pairing: PairStartResult; onClose: () => void }) {
  const qc = useQueryClient();
  const client = useCoreClient();
  const [remaining, setRemaining] = useState(() => Date.parse(pairing.expiresAt) - Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  const svg = useMemo(() => qrSvg(pairing.url), [pairing.url]);

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
            In the fabPlane app on your phone, tap <span className="font-medium">Scan</span> and point it at this code.
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
          </div>
          <div className="rounded-md bg-panel-2 p-2 text-[11px] text-muted">
            <div className="mb-1 font-medium text-fg">Reachable at</div>
            {pairing.endpoints.length === 0 ? (
              <div>No network address found — is this machine on a tailnet or LAN?</div>
            ) : (
              pairing.endpoints.map((e) => (
                <div key={endpointLabel(e)} className="font-mono">
                  {endpointLabel(e)} <span className="not-italic">({e.kind === "tailscale" ? "tailscale" : e.iface})</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
