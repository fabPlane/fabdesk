import type { AgentId, Settings } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { Badge, Button, Dialog, Input, Select, Spinner } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useDoctor, usePatchSettings, useSettings } from "@fabdesk/client-core";
import { shortcutList } from "../hooks/useShortcuts";
import { isThemeId, THEME_IDS, THEME_LABELS, useTheme } from "../hooks/useTheme";
import { useAuthStore } from "@fabdesk/client-core";
import { RemoteSection } from "./RemoteSection";
import { SETTINGS_SECTIONS, useUiStore, type SettingsSection } from "../stores/ui";
import { cn } from "../util";

const LABELS: Record<SettingsSection, string> = {
  agents: "Agents",
  kicad: "KiCad & ngspice",
  router: "Router",
  auth: "Account",
  remote: "Remote access",
  appearance: "Appearance",
  privacy: "Privacy",
  shortcuts: "Shortcuts",
};

type AgentSettings = Settings["agents"][string];
const DEFAULT_AGENT: AgentSettings = { binaryPath: null, model: null, permissionMode: "acceptEdits", extraAllowedTools: [], pickerModels: [] };

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[180px_1fr] items-center gap-3 py-1.5 text-xs">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function SettingsDialog() {
  const { host } = useCore();
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const requestedSection = useUiStore((s) => s.settingsSection);
  const themeId = useTheme();
  const setThemeId = useUiStore((s) => s.setThemeId);
  const [section, setSection] = useState<SettingsSection>("agents");
  useEffect(() => {
    if (open && requestedSection) setSection(requestedSection);
  }, [open, requestedSection]);
  const settings = useSettings();
  const doctor = useDoctor();
  const patch = usePatchSettings();
  const [draft, setDraft] = useState<Settings | null>(null);
  // Settings can change behind the dialog's back (PATCH /settings from an agent or a script); re-read them on
  // every open so the draft, and a later Save, start from what the core actually has.
  useEffect(() => {
    if (open) void settings.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && settings.data) setDraft(structuredClone(settings.data));
  }, [open, settings.data]);

  const update = (fn: (s: Settings) => Settings) => setDraft((d) => (d ? fn(d) : d));
  const updateAgent = (id: string, p: Partial<AgentSettings>) =>
    update((s) => ({ ...s, agents: { ...s.agents, [id]: { ...(s.agents[id] ?? DEFAULT_AGENT), ...p } } }));
  const dirty = !!draft && !!settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data);
  const save = () => {
    if (draft) patch.mutate(draft);
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Settings" className="h-[80vh] w-[860px]">
      <div className="flex h-full gap-4">
        <nav className="w-40 shrink-0">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={cn(
                "block w-full rounded-md px-2.5 py-1.5 text-left text-[13px]",
                s === section ? "bg-panel-2 font-medium" : "text-muted hover:text-fg",
              )}
            >
              {LABELS[s]}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto pr-1">
          {!draft ? (
            <Spinner />
          ) : section === "agents" ? (
            <div className="space-y-4">
              <Row label="Default agent">
                <Select value={draft.defaultAgent} onChange={(e) => update((s) => ({ ...s, defaultAgent: e.target.value as AgentId }))}>
                  {(doctor.data?.agents ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </Select>
              </Row>
              {(doctor.data?.agents ?? []).map((a) => {
                const cfg = draft.agents[a.id] ?? DEFAULT_AGENT;
                return (
                  <div key={a.id} className="rounded-lg border border-border p-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-medium">{a.displayName}</span>
                      {a.installed ? (
                        <Badge tone="success">installed{a.version ? ` ${a.version}` : ""}</Badge>
                      ) : (
                        <Badge tone="warning">not found</Badge>
                      )}
                      {a.path && <span className="truncate font-mono text-[11px] text-muted">{a.path}</span>}
                    </div>
                    {!a.installed && <div className="mb-2 text-xs text-muted">{a.installHint}</div>}
                    <Row label="Binary path" hint="Leave empty to use PATH">
                      <Input value={cfg.binaryPath ?? ""} onChange={(e) => updateAgent(a.id, { binaryPath: e.target.value || null })} placeholder={a.path ?? "auto-detect"} />
                    </Row>
                    <Row label="Model">
                      <Input list={`settings-models-${a.id}`} value={cfg.model ?? ""} onChange={(e) => updateAgent(a.id, { model: e.target.value || null })} placeholder="agent default" />
                      <datalist id={`settings-models-${a.id}`}>
                        {a.models.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </Row>
                    <Row label="Models in picker" hint="Comma-separated; empty shows the first three known models">
                      <Input
                        value={cfg.pickerModels.join(", ")}
                        onChange={(e) => updateAgent(a.id, { pickerModels: e.target.value.split(",").map((m) => m.trim()).filter(Boolean) })}
                        placeholder={a.models.slice(0, 3).join(", ")}
                      />
                    </Row>
                    <Row label="Permission mode" hint="How much the agent may do without asking">
                      <Select value={cfg.permissionMode} onChange={(e) => updateAgent(a.id, { permissionMode: e.target.value as AgentSettings["permissionMode"] })}>
                        <option value="acceptEdits">acceptEdits</option>
                        <option value="auto">auto</option>
                        <option value="bypass">bypass</option>
                      </Select>
                    </Row>
                  </div>
                );
              })}
            </div>
          ) : section === "kicad" ? (
            <div>
              <Row
                label="kicad-cli path"
                hint={
                  doctor.data?.kicad.found
                    ? `using ${doctor.data.kicad.version ?? ""} at ${doctor.data.kicad.path ?? ""}`
                    : "bundled FabPlane KiCad (leave blank), or set a path to override"
                }
              >
                <Input
                  value={draft.kicadCliPath ?? ""}
                  onChange={(e) => update((s) => ({ ...s, kicadCliPath: e.target.value || null }))}
                  placeholder="bundled (auto)"
                />
              </Row>
              <Row label="ngspice path" hint={doctor.data?.ngspice.found ? `detected at ${doctor.data.ngspice.path ?? ""}` : "not detected"}>
                <Input value={draft.ngspicePath ?? ""} onChange={(e) => update((s) => ({ ...s, ngspicePath: e.target.value || null }))} placeholder="auto-detect" />
              </Row>
              {doctor.data && doctor.data.warnings.length > 0 && (
                <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                  {doctor.data.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
            </div>
          ) : section === "router" ? (
            <div>
              <Row label="Autorouter">
                <Select value={draft.router} onChange={(e) => update((s) => ({ ...s, router: e.target.value as Settings["router"] }))}>
                  <option value="capacity">capacity (built-in JS router)</option>
                  <option value="freerouting">freerouting</option>
                </Select>
              </Row>
              <div className="mt-2 space-y-1 text-xs">
                {(doctor.data?.routers ?? []).map((r) => (
                  <div key={r.id} className="flex items-center gap-2">
                    <Badge tone={r.ready ? "success" : r.present ? "warning" : "neutral"}>{r.id}</Badge>
                    <span className="text-muted">{r.detail}</span>
                  </div>
                ))}
              </div>
              <Row label="Keep core running" hint="Leave the daemon up after quitting so external agents can keep using MCP">
                <input type="checkbox" checked={draft.keepCoreRunning} onChange={(e) => update((s) => ({ ...s, keepCoreRunning: e.target.checked }))} />
              </Row>
              <Row label="WebMCP write tools" hint="Expose tools that modify the project to browser agents (read-only by default)">
                <input type="checkbox" checked={draft.webmcpWriteTools} onChange={(e) => update((s) => ({ ...s, webmcpWriteTools: e.target.checked }))} />
              </Row>
            </div>
          ) : section === "auth" ? (
            <AuthSection />
          ) : section === "remote" ? (
            <RemoteSection />
          ) : section === "appearance" ? (
            <Row label="Theme" hint="fabPlane themes match fabplane.com; the System themes are the neutral light/dark look. Stored on this device.">
              <Select
                value={themeId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!isThemeId(id)) return;
                  setThemeId(id);
                  update((s) => ({ ...s, theme: id.endsWith("-dark") ? "dark" : "light" }));
                }}
              >
                {THEME_IDS.map((id) => (
                  <option key={id} value={id}>
                    {THEME_LABELS[id]}
                  </option>
                ))}
              </Select>
            </Row>
          ) : section === "privacy" ? (
            <div>
              <Row label="Error reporting" hint="Send crash and error reports to Sentry so bugs get fixed. Reports carry no prompts, board files, tokens or project paths. Turning this off applies immediately; turning it back on applies after a restart.">
                <input type="checkbox" checked={draft.errorReporting} onChange={(e) => update((s) => ({ ...s, errorReporting: e.target.checked }))} />
              </Row>
            </div>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {shortcutList(host.platform).map((s) => (
                  <tr key={s.label} className="border-b border-border/60">
                    <td className="py-1.5 pr-4 font-mono text-muted">{s.keys}</td>
                    <td className="py-1.5">{s.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {section !== "auth" && section !== "remote" && section !== "shortcuts" && (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
          {patch.isError && <span className="mr-auto text-xs text-danger">{(patch.error as Error).message}</span>}
          {patch.isSuccess && !dirty && <span className="mr-auto text-xs text-success">Saved</span>}
          <Button onClick={() => settings.data && setDraft(structuredClone(settings.data))} disabled={!dirty}>
            Reset
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || patch.isPending}>
            {patch.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function AuthSection() {
  const { client, host } = useCore();
  const state = useAuthStore((s) => s.state);
  const localAllowed = useAuthStore((s) => s.localAllowed);
  const setState = useAuthStore((s) => s.setState);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = async () => {
    setBusy(true);
    try {
      setState(await client.login());
    } finally {
      setBusy(false);
    }
  };
  const loginWithPassword = async () => {
    setBusy(true);
    try {
      setState(await client.login({ email: email.trim(), password }));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await client.logout();
      setState(await client.authState());
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <Spinner />;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge tone={state.status === "signed_in" ? "success" : state.status === "error" ? "danger" : "neutral"}>{state.status}</Badge>
        <Badge tone={state.mode === "local" ? "warning" : "accent"}>{state.mode === "local" ? "Local mode" : "fabPlane"}</Badge>
      </div>
      {state.principal && (
        <div>
          Signed in as <span className="font-medium">{state.principal.displayName ?? state.principal.handle ?? state.principal.subject}</span>
          {state.principal.email && <span className="text-muted"> ({state.principal.email})</span>}
        </div>
      )}
      {state.status === "signed_in" && state.mode === "fabplane" && (
        <div className="text-muted">
          Theme, default agent, runtime mode, error reporting and notification prefs sync to this
          account. Paths, remote access and keep-core-running stay on this machine. Later, signed-in
          phones will reach this computer through the backend.
        </div>
      )}
      {state.status === "pending" && state.pending && (
        <div className="rounded-md border border-border p-3">
          <div>Enter this code in the browser:</div>
          <div className="my-1 font-mono text-2xl tracking-widest">{state.pending.userCode}</div>
          <Button size="sm" onClick={() => void host.openExternal(state.pending!.verificationUriComplete)}>
            Open browser
          </Button>
        </div>
      )}
      {state.error && <div className="text-danger">{state.error}</div>}
      <div className="flex gap-2">
        {state.status === "signed_in" && state.mode === "fabplane" ? (
          <Button onClick={() => void logout()} disabled={busy}>
            Sign out
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void login()} disabled={busy || state.status === "pending"}>
            Sign in with fabPlane
          </Button>
        )}
        {localAllowed && host.setLocalAuth && (
          <Button onClick={() => void host.setLocalAuth?.(state.mode !== "local")} disabled={busy}>
            {state.mode === "local" ? "Leave local mode" : "Use local mode"}
          </Button>
        )}
      </div>
      {localAllowed && state.status !== "signed_in" && state.status !== "pending" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void loginWithPassword();
          }}
        >
          <div className="text-muted">Staging/local only. Password login is not available in production.</div>
          <Input
            type="text"
            autoComplete="username"
            inputMode="email"
            placeholder="email or handle"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !email.trim() || !password}>
            Sign in with password
          </Button>
        </form>
      )}
      {localAllowed && (
        <div className="text-muted">Local mode skips fabPlane sign-in; it is only available in development builds or with a .fabdesk-dev marker.</div>
      )}
    </div>
  );
}
