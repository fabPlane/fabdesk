import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudAccountId, useAuthStore, useCore } from "@fabdesk/client-core";
import type { AuthState } from "@fabdesk/protocol";
import { Badge, Button, Dialog, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { TeamProjectsDialog } from "../board/TeamProjectsDialog";
import { useUiStore } from "../stores/ui";
import { principalInitials, principalLabel } from "./principal";
import { CloudAccount } from "./CloudAccount";
import "./profile-account.css";

export function ProfileButton() {
  const state = useAuthStore((s) => s.state);
  const signedIn = !!cloudAccountId(state);
  const label = signedIn ? principalLabel(state?.principal, "fabplane") : "Signed out";
  return (
    <button
      type="button"
      className="fd-profile-button"
      aria-label="Profile & account"
      aria-haspopup="dialog"
      title={`Profile & account · ${label}`}
      onClick={() => useUiStore.getState().setProfileOpen(true)}
    >
      <span className="fd-profile-avatar" aria-hidden="true">
        {signedIn ? principalInitials(label) : <Icon name="user" width={18} height={18} />}
      </span>
    </button>
  );
}

/** A portal keeps account recovery above the sharing/invitation dialog that opened it. */
export function ProfileAccountDialog() {
  const open = useUiStore((s) => s.profileOpen);
  const [shared, setShared] = useState(false);
  const reason = useUiStore((s) => s.profileReason);
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {shared && <TeamProjectsDialog onClose={() => setShared(false)} />}
      {open && (
        <ProfileAccountWindow
          onShared={() => {
            useUiStore.getState().setProfileOpen(false);
            if (reason !== "invitation") setShared(true);
          }}
        />
      )}
    </>,
    document.body,
  );
}

function ProfileAccountWindow({ onShared }: { onShared: () => void }) {
  const { client, host } = useCore();
  const cache = useQueryClient();
  const state = useAuthStore((s) => s.state);
  const localAllowed = useAuthStore((s) => s.localAllowed);
  const reason = useUiStore((s) => s.profileReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const status = useQuery({
    queryKey: ["auth"],
    queryFn: () => client.authState(),
    retry: false,
    refetchInterval: state?.status === "pending" ? 2500 : false,
  });
  const signedIn = !!cloudAccountId(state);
  const local = state?.mode === "local";
  const pending = state?.status === "pending" ? state.pending : undefined;
  const failed = state?.status === "error";
  const expired = reason === "expired" || (state?.status === "signed_out" && !!state.error);
  const label = signedIn ? principalLabel(state?.principal, "fabplane") : "fabPlane account";
  const previousStatus = useRef(state?.status);
  useEffect(() => {
    if (signedIn) {
      setSwitching(false);
      setPassword("");
      if (
        previousStatus.current !== "signed_in" &&
        useUiStore.getState().profileReason === "expired"
      )
        useUiStore.getState().setProfileOpen(true);
    }
    previousStatus.current = state?.status;
  }, [signedIn, state?.status]);
  // Auth changes also arrive through SSE; write both consumers so polling cannot revive old identity.
  const accept = async (next: AuthState) => {
    await cache.cancelQueries({ queryKey: ["auth"] });
    cache.setQueryData(["auth"], next);
    useAuthStore.getState().setState(next);
  };
  const run = async (action: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cache.cancelQueries({ queryKey: ["auth"] });
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const signIn = async (credentials?: { email: string; password: string }) => {
    if (local && host.setLocalAuth) {
      await host.setLocalAuth(false);
      return;
    }
    const next = await client.login(credentials);
    await accept(next);
    if (next.pending && !credentials) await host.openExternal(next.pending.verificationUriComplete);
  };
  const signOut = async () => {
    await client.logout();
    await accept(await client.authState());
  };
  const close = () => {
    if (!busy) useUiStore.getState().setProfileOpen(false);
  };
  return (
    <Dialog
      open
      title="Profile & account"
      onClose={close}
      closeDisabled={busy}
      className="fd-profile-dialog w-[480px]"
      fallbackFocus={() => {
        const dialogs = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
        ).filter((dialog) => !dialog.classList.contains("fd-profile-dialog"));
        const parent = dialogs.at(-1);
        return (
          parent?.querySelector<HTMLElement>("button:not([disabled])") ??
          parent ??
          document.querySelector<HTMLButtonElement>(".fd-profile-button")
        );
      }}
    >
      <div className="fd-profile-content">
        <section className="fd-profile-identity" aria-label="fabPlane identity">
          <span className="fd-profile-avatar fd-profile-avatar-large" aria-hidden="true">
            {signedIn ? principalInitials(label) : <Icon name="user" width={25} height={25} />}
          </span>
          <div>
            <h2>{label}</h2>
            {signedIn && <p>{state?.principal?.email || "No email provided by this account"}</p>}
            <Badge tone={expired || failed ? "warning" : signedIn ? "success" : "neutral"}>
              {pending
                ? "Signing in"
                : expired
                  ? "Session expired"
                  : signedIn
                    ? "Signed in"
                    : failed
                      ? "Sign-in failed"
                      : "Signed out"}
            </Badge>
          </div>
        </section>
        {reason === "invitation" && (
          <p className="fd-profile-callout">
            Use the email address this invitation was sent to. After signing in, close this window
            to return to the same invitation.
          </p>
        )}
        {reason === "sharing" && (
          <p className="fd-profile-callout">
            Sign in to manage this project’s sharing. Close this window to return to Share.
          </p>
        )}
        {reason === "expired" && (
          <p role="alert" className="fd-profile-callout">
            Your fabPlane session was rejected or expired. Sign in again, then return to the sharing
            window and retry.
          </p>
        )}
        {switching && (
          <p role="status">
            Choose the other account in your browser. If the browser is already signed in, switch
            accounts there before approving the code.
          </p>
        )}
        {pending ? (
          <section className="fd-profile-pending" aria-label="Browser sign-in">
            <p>Approve this code in your browser:</p>
            <strong className="fd-profile-code">{pending.userCode}</strong>
            <Button
              onClick={() => void run(() => host.openExternal(pending.verificationUriComplete))}
              disabled={busy}
            >
              Open browser <Icon name="externalLink" width={15} height={15} />
            </Button>
            <p role="status">
              <Spinner /> Waiting for approval · expires{" "}
              {new Date(pending.expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </section>
        ) : (
          <div className="fd-profile-actions">
            {signedIn && !expired ? (
              <>
                <Button
                  onClick={() =>
                    void run(async () => {
                      setSwitching(true);
                      await signOut();
                      await signIn();
                    })
                  }
                  disabled={busy}
                >
                  Switch account
                </Button>
                <Button variant="ghost" onClick={() => void run(signOut)} disabled={busy}>
                  Sign out
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={busy || !state}
                onClick={() =>
                  void run(async () => {
                    if (signedIn) await signOut();
                    await signIn();
                  })
                }
              >
                {busy ? (
                  <>
                    <Spinner /> Starting sign-in…
                  </>
                ) : expired || failed ? (
                  "Sign in again"
                ) : (
                  "Sign in with fabPlane"
                )}
              </Button>
            )}
          </div>
        )}
        {(error || state?.error) && (
          <p role="alert" className="fd-profile-error">
            {error ?? state?.error}
          </p>
        )}
        {status.isError && (
          <div role="alert" className="fd-profile-error">
            Could not refresh account status.{" "}
            <Button size="sm" onClick={() => void status.refetch()}>
              Retry
            </Button>
          </div>
        )}
        <p className="fd-profile-note">
          Local projects and edits stay on this device when you sign out or switch accounts. They
          aren’t transferred to the next account.
        </p>
        <section className="fd-profile-section">
          <Button className="fd-profile-link" onClick={onShared} disabled={busy}>
            <Icon name="folderOpen" width={18} height={18} />
            Projects shared with me
            <Icon name="chevronRight" width={16} height={16} />
          </Button>
          <p className="fd-profile-note">
            Signing in doesn’t publish projects or grant access. Manage each project’s access in
            Share.
          </p>
        </section>
        <section className="fd-profile-section">
          <div className="fd-profile-row">
            <strong>Agent connections</strong>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                close();
                useUiStore.getState().setSettingsOpen(true, "agents");
              }}
            >
              Agent settings <Icon name="chevronRight" width={14} height={14} />
            </Button>
          </div>
          <p className="fd-profile-note">
            Claude, Codex and other agents sign in separately from your fabPlane account.
          </p>
        </section>
        {signedIn && (
          <details className="fd-profile-section">
            <summary>Dashboard & organization</summary>
            <CloudAccount dashboardUrl={state?.dashboardUrl} />
          </details>
        )}
        {localAllowed && (
          <details className="fd-profile-section">
            <summary>Development options{local ? " · Local mode" : ""}</summary>
            <p className="fd-profile-note">
              Local mode uses no fabPlane account. Changing local mode restarts the development
              daemon. Password sign-in is for staging/local environments only.
            </p>
            {!signedIn && !pending && !local && (
              <form
                className="fd-profile-dev-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => signIn({ email: email.trim(), password }));
                }}
              >
                <label>
                  Email or handle
                  <Input
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  Password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <Button type="submit" disabled={busy || !email.trim() || !password}>
                  Sign in with password
                </Button>
              </form>
            )}
            {host.setLocalAuth && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(() => host.setLocalAuth!(state?.mode !== "local"))}
              >
                {local ? "Leave local mode" : "Use local mode"}
              </Button>
            )}
          </details>
        )}
        <footer className="fd-profile-footer">
          <Button onClick={close} disabled={busy}>
            Done
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
