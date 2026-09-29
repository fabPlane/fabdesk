import { useEffect, useState } from "react";
import { Badge, Button, Input, Spinner } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useAuthStore } from "@fabdesk/client-core";
import { isMac } from "../util";
import { isRevealDevOptionsShortcut, showDevSignInOptions } from "./dev-options";

const STAGING_PASSWORD_HINT =
  "Staging/local only. Password login is not available in production.";

/**
 * Browser device-code sign-in (production). The staging password form and local mode are shown up
 * front in dev builds; every other build keeps them behind the undocumented Cmd+L / Ctrl+L reveal,
 * which also works in packaged builds (see `showDevSignInOptions`).
 */
export function LoginScreen() {
  const { client, host } = useCore();
  const state = useAuthStore((s) => s.state);
  const setState = useAuthStore((s) => s.setState);
  const [revealed, setRevealed] = useState(false);
  const devOptions = showDevSignInOptions({ devBuild: host.devBuild, revealed });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

  useEffect(() => {
    if (host.devBuild) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isRevealDevOptionsShortcut(e, host.platform)) return;
      e.preventDefault();
      setRevealed((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host.devBuild, host.platform]);

  const loginWithPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await client.login({ email: email.trim(), password });
      setState(next);
      if (next.status === "error" && next.error) setError(next.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loginWithDevice = async () => {
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
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <div className="mb-1 text-lg font-semibold">fabPlane</div>
        <div className="mb-5 text-xs text-muted">Sign in with your fabPlane account to start designing boards.</div>
        {pending ? (
          <div className="space-y-3">
            <div className="text-xs text-muted">Approve this code in the browser at {pending.verificationUri}:</div>
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
          <div className="space-y-3">
            <Button variant="primary" className="w-full" onClick={() => void loginWithDevice()} disabled={busy || !state}>
              {busy ? "Starting sign-in..." : "Sign in with fabPlane"}
            </Button>
            {devOptions && (
              <form
                className="space-y-3 border-t border-border pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loginWithPassword();
                }}
              >
                <div className="text-[11px] leading-relaxed text-muted">{STAGING_PASSWORD_HINT}</div>
                <Input
                  type="text"
                  autoComplete="username"
                  inputMode="email"
                  placeholder="email or handle"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy || !state}
                />
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy || !state}
                />
                <Button className="w-full" type="submit" disabled={busy || !state || !email.trim() || !password}>
                  {busy ? "Signing in..." : "Sign in with password"}
                </Button>
              </form>
            )}
          </div>
        )}
        {(error || state?.error) && <div className="mt-3 text-xs text-danger">{error ?? state?.error}</div>}
        {devOptions && host.setLocalAuth && (
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 flex items-center justify-center gap-2 text-xs text-muted">
              <Badge tone="warning">dev</Badge> Local mode skips sign-in and restarts the core daemon with --local-auth.
            </div>
            <Button className="w-full" onClick={() => void host.setLocalAuth?.(true)}>
              Continue in local mode
            </Button>
          </div>
        )}
        {devOptions && !host.devBuild && (
          <div className="mt-3 text-center text-[11px] text-muted">
            {isMac(host.platform) ? "\u2318L" : "Ctrl+L"} hides these options again.
          </div>
        )}
      </div>
    </div>
  );
}
