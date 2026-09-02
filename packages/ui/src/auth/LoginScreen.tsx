import { useEffect, useState } from "react";
import { Badge, Button, Spinner } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { useAuthStore } from "../stores/auth";

/** Device-code sign-in (RFC 8628) plus the local-mode escape hatch when the host allows it. */
export function LoginScreen() {
  const { client, host } = useCore();
  const state = useAuthStore((s) => s.state);
  const setState = useAuthStore((s) => s.setState);
  const localAllowed = useAuthStore((s) => s.localAllowed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll while pending in case the SSE stream is not up yet.
  useEffect(() => {
    if (state?.status !== "pending") return;
    const id = setInterval(() => {
      client
        .authState()
        .then(setState)
        .catch(() => {});
    }, 2500);
    return () => clearInterval(id);
  }, [state?.status, client, setState]);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await client.login();
      setState(next);
      if (next.pending) void host.openExternal(next.pending.verificationUriComplete);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pending = state?.status === "pending" ? state.pending : undefined;
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <div className="mb-1 text-lg font-semibold">Fabdesk</div>
        <div className="mb-5 text-xs text-muted">Sign in with your Fabplane account to start designing boards.</div>
        {pending ? (
          <div className="space-y-3">
            <div className="text-xs text-muted">Enter this code at {pending.verificationUri}:</div>
            <div className="select-all rounded-lg border border-border bg-panel-2 py-3 text-center font-mono text-3xl tracking-[0.3em]">
              {pending.userCode}
            </div>
            <Button variant="primary" className="w-full" onClick={() => void host.openExternal(pending.verificationUriComplete)}>
              Open browser
            </Button>
            <div className="flex items-center justify-center gap-2 text-xs text-muted">
              <Spinner /> Waiting for approval... expires {new Date(pending.expiresAt).toLocaleTimeString()}
            </div>
          </div>
        ) : (
          <Button variant="primary" className="w-full" onClick={() => void login()} disabled={busy || !state}>
            {busy ? "Starting sign-in..." : "Sign in with Fabplane"}
          </Button>
        )}
        {(error || state?.error) && <div className="mt-3 text-xs text-danger">{error ?? state?.error}</div>}
        {state?.status === "error" && (
          <Button className="mt-2 w-full" onClick={() => void login()} disabled={busy}>
            Try again
          </Button>
        )}
        {localAllowed && host.setLocalAuth && (
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted">
              <Badge tone="warning">dev</Badge> Local mode skips sign-in and restarts the core daemon with --local-auth.
            </div>
            <Button className="w-full" onClick={() => void host.setLocalAuth?.(true)}>
              Continue in local mode
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
