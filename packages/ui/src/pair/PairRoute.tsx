/**
 * `/pair`: the page a `https://fabplane.com/pair?host=…#token=…` link lands on. Reads the link,
 * refuses what cannot work (a plain-http computer from an https page), claims the one-time token
 * for a device token, saves the computer, and hands over to the app.
 *
 * The claim goes straight from this browser to the computer — fabplane.com never sees the token
 * (it is in the fragment) and never sees the device token (the daemon's answer).
 */
import { claimPairing } from "@fabdesk/client-core";
import { useEffect, useRef, useState } from "react";
import { Button, Spinner } from "../components/ui";
import type { SavedHost } from "./hosts";
import { browserLabel, parsePairLink } from "./parse";
import { useSavedHosts } from "./store";

type Step =
  | { kind: "invalid"; message: string }
  | { kind: "claiming"; host: string }
  | { kind: "failed"; host: string; message: string }
  | { kind: "paired"; host: SavedHost };

export function PairRoute({ onPaired }: { onPaired: (host: SavedHost) => void }) {
  const add = useSavedHosts((s) => s.add);
  // Read once, during the first render: the effect below strips the fragment from the URL.
  const [link] = useState(() =>
    parsePairLink({
      search: location.search,
      hash: location.hash,
      pageProtocol: location.protocol,
    }),
  );
  const [step, setStep] = useState<Step | null>(null);
  // The claim spends the one-time token, so it must run exactly once — StrictMode's mount →
  // unmount → mount in development would otherwise burn it on the first pass and 401 on the second.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Whatever happens next, the token must not sit in the address bar or the history entry
    // (a screenshot, a shared tab, a browser sync). One-time or not, it is a secret until claimed.
    history.replaceState(null, "", location.pathname + location.search);
    if (!link.ok) {
      setStep({ kind: "invalid", message: link.message });
      return;
    }
    setStep({ kind: "claiming", host: link.host });
    claimPairing(link.host, link.token, {
      label: browserLabel(navigator.userAgent),
      platform: "web",
    })
      .then((result) => {
        const host: SavedHost = {
          host: link.host,
          deviceToken: result.deviceToken,
          coreName: result.core.name,
          coreId: result.core.coreId ?? null,
          deviceId: result.device.id,
          pairedAt: result.device.createdAt,
        };
        add(host);
        setStep({ kind: "paired", host });
      })
      .catch((e: unknown) => {
        setStep({ kind: "failed", host: link.host, message: describeClaimFailure(e, link.host) });
      });
  }, [add, link]);

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6 text-fg">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <div className="mb-1 text-lg font-semibold">Pair this browser</div>
        {step === null || step.kind === "claiming" ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Pairing with {step?.host ?? "the computer"}…
          </div>
        ) : step.kind === "paired" ? (
          <>
            <div className="text-sm">
              Paired with <span className="font-medium">{step.host.coreName}</span>. This browser is
              now listed under Settings › Remote access on that computer, where it can be revoked.
            </div>
            <div className="mt-4">
              <Button variant="primary" onClick={() => onPaired(step.host)}>
                Open fabPlane
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-danger">
              {step.kind === "invalid" ? "This link cannot be used" : "Pairing failed"}
            </div>
            <div className="mt-2 text-sm text-muted">{step.message}</div>
            {step.kind === "failed" && (
              <div className="mt-2 break-all font-mono text-[11px] text-muted">{step.host}</div>
            )}
            <div className="mt-4 text-xs text-muted">
              On the computer: Settings › Remote access › Pair a device shows a fresh link. It is
              good for three minutes.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The daemon's refusal is the answer when it answered; a transport error from a browser is mostly
 * one of three things it will not tell us apart: not reachable, no CORS for this page's origin, or
 * a certificate the browser does not trust — so list them.
 */
function describeClaimFailure(e: unknown, host: string): string {
  // client-core's `PairingRefusedError` is not exported from its index; its name and status are.
  if (e instanceof Error && e.name === "PairingRefusedError") {
    return (e as Error & { status?: number }).status === 401
      ? "The computer did not accept this code — it has expired, was already used, or too many attempts were made. Show a new one."
      : `The computer refused: ${e.message}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return (
    `Could not reach ${host} from this page (${msg}). Check that the computer is awake and this device is on the same tailnet, ` +
    "that its remote listener allows this site's origin, and that the browser trusts its certificate (open the address in a new tab)."
  );
}
