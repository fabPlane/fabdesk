import { askAboutSurface } from "../chat/useAssistantSurface";
import { Icon } from "../components/Icon";
import type { AgentId, Settings } from "@fabdesk/protocol";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Dialog, Input, Select, Spinner } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useDoctor, usePatchSettings, usePrivacy, useSettings } from "@fabdesk/client-core";
import { usageArchiveAllowed, usageArchiveChoice } from "@fabdesk/protocol";
import { shortcutList } from "../hooks/useShortcuts";
import { THEME_IDS, THEME_LABELS, useTheme } from "../hooks/useTheme";
import { THEME_BACKGROUNDS, THEME_PANELS, THEME_FOREGROUNDS } from "../theme/resolve";
import { RemoteSection } from "./RemoteSection";
import { RoutersSection } from "./RoutersSection";
import { VoiceSection } from "./VoiceSection";
import { LanguageSection } from "./LanguageSection";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { withoutRouterDefault } from "./routers";
import { SETTINGS_SECTIONS, useUiStore, type SettingsSection } from "../stores/ui";
import { cn } from "../util";
import { InstallHint } from "../components/InstallHint";
import { privacyScreenRequired } from "../app/privacy-gate";

const LABELS: Record<SettingsSection, string> = {
  agents: "Agents",
  kicad: "KiCad & ngspice",
  router: "Routers",
  auth: "Account",
  remote: "Remote access",
  voice: "Voice",
  appearance: "Appearance",
  language: "Language",
  privacy: "Privacy",
  shortcuts: "Shortcuts",
};

const SECTION_KEYS: Record<SettingsSection, MessageKey> = {
  agents: "settings.section.agents",
  kicad: "settings.section.kicad",
  router: "settings.section.router",
  auth: "settings.section.auth",
  remote: "settings.section.remote",
  voice: "settings.section.voice",
  appearance: "settings.section.appearance",
  language: "settings.section.language",
  privacy: "settings.section.privacy",
  shortcuts: "settings.section.shortcuts",
};

type AgentSettings = Settings["agents"][string];
const DEFAULT_AGENT: AgentSettings = { binaryPath: null, model: null, permissionMode: "acceptEdits", extraAllowedTools: [], pickerModels: [] };

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fd-settings-row grid grid-cols-[180px_minmax(0,1fr)] items-center gap-4 py-2 text-[13px]">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-4 text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function AgentModelSetting({ name, models, value, onChange }: { name: string; models: string[]; value: string | null; onChange: (value: string | null) => void }) {
  const [custom, setCustom] = useState(false);
  const usingCustom = custom || !!value && !models.includes(value);
  return <div className="min-w-0 space-y-2">
    <Select aria-label={`${name} model`} className="w-full" value={usingCustom ? "__custom_model__" : value ?? ""} onChange={event => {
      const next = event.target.value;
      setCustom(next === "__custom_model__");
      if (next !== "__custom_model__") onChange(next || null);
    }}>
      <option value="">Agent default</option>
      {models.map(model => <option key={model} value={model}>{model}</option>)}
      <option value="__custom_model__">Custom model ID…</option>
    </Select>
    {usingCustom && <Input aria-label={`${name} custom model ID`} autoComplete="off" value={value ?? ""} placeholder="Enter a model ID" onChange={event => onChange(event.target.value || null)} />}
  </div>;
}

export function SettingsDialog() {
  const { t } = useI18n();
  const { host } = useCore();
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const requestedSection = useUiStore((s) => s.settingsSection);
  const themeId = useTheme();
  const setThemeId = useUiStore((s) => s.setThemeId);
  const storedTheme = useUiStore((s) => s.themeId);
  const originalTheme = useRef(storedTheme);
  const [confirmClose, setConfirmClose] = useState(false);
  const [modelReset, setModelReset] = useState(0);
  // Keep the displayed section and the assistant’s current-window context in one store.
  const section = requestedSection ?? "agents";
  const projectId = useUiStore(s => s.activeProjectId);
  const settings = useSettings();
  const doctor = useDoctor();
  const patch = usePatchSettings();
  const privacyScreen = privacyScreenRequired(usePrivacy());
  const [draft, setDraft] = useState<Settings | null>(null);
  // Settings can change behind the dialog's back (PATCH /settings from an agent or a script); re-read them on
  // every open so the draft, and a later Save, start from what the core actually has.
  useEffect(() => {
    if (!open) return;
    originalTheme.current = useUiStore.getState().themeId;
    setDraft(null);
    let active = true;
    void settings.refetch().then((result) => { if (active && result.data) setDraft(structuredClone(result.data)); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (fn: (s: Settings) => Settings) => setDraft((d) => (d ? fn(d) : d));
  const updateAgent = (id: string, p: Partial<AgentSettings>) =>
    update((s) => ({ ...s, agents: { ...s.agents, [id]: { ...(s.agents[id] ?? DEFAULT_AGENT), ...p } } }));
  // The router default and TraceMaker manifest URL are saved by their own controls
  // (see withoutRouterDefault); they are not part of the draft.
  const dirty = (!!draft && !!settings.data && JSON.stringify(withoutRouterDefault(draft)) !== JSON.stringify(withoutRouterDefault(settings.data))) || storedTheme !== originalTheme.current;
  const reset = () => { setModelReset(value => value + 1); if (settings.data) setDraft(structuredClone(settings.data)); setThemeId(originalTheme.current); };
  const close = () => { if (patch.isPending) return; if (dirty) setConfirmClose(true); else setOpen(false); };
  const save = () => {
    if (draft) patch.mutate(withoutRouterDefault(draft), { onSuccess: () => { originalTheme.current = useUiStore.getState().themeId; } });
  };

  return (
    <><Dialog open={open} onClose={close} closeDisabled={patch.isPending} title={t("settings.title")} className="fd-settings h-[80vh] w-[860px]">
      <div className="fd-settings-layout flex min-h-0 flex-1 gap-6">
        <nav className="w-40 shrink-0 overflow-y-auto border-r border-border pr-3" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setOpen(true, s)}
              className={cn(
                "mb-0.5 block min-h-9 w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                s === section ? "bg-panel-2 font-semibold text-fg" : "text-fg hover:bg-panel-2/50",
              )}
            >
              {t(SECTION_KEYS[s])}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto pr-1">
          <h2 className="mb-5 text-xl font-semibold tracking-tight">{t(SECTION_KEYS[section])}</h2>
          {!draft && settings.isError ? <div role="alert" className="text-sm text-danger">Could not load settings. Close and reopen Settings to retry.</div> : !draft ? (
            <Spinner />
          ) : section === "agents" ? (
            <div className="space-y-4">
              <Row label="Default agent" hint="New chats remember the agent and model you select in the composer.">
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
                    {!a.installed && <div className="mb-2"><InstallHint text={a.installHint} /></div>}
                    <Row label="Binary path" hint="Leave empty to use PATH">
                      <Input value={cfg.binaryPath ?? ""} onChange={(e) => updateAgent(a.id, { binaryPath: e.target.value || null })} placeholder={a.path ?? "auto-detect"} />
                    </Row>
                    <Row label="Model">
                      <AgentModelSetting key={`${a.id}:${modelReset}`} name={a.displayName} models={a.models} value={cfg.model} onChange={model => updateAgent(a.id, { model })} />
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
                    : "bundled fabPlane KiCad (leave blank), or set a path to override"
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
              <RoutersSection />
              <div className="mt-4 space-y-1 text-xs">
                <div className="font-medium">Bridge</div>
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
              <Row label="Board checks in Finish it" hint="For a project with a placed board, Finish it is done when A1-A9 pass and the review gate passes (board tools), not only DRC/ERC">
                <input type="checkbox" checked={draft.boardChecksInFinishIt !== false} onChange={(e) => update((s) => ({ ...s, boardChecksInFinishIt: e.target.checked }))} />
              </Row>
            </div>
          ) : section === "auth" ? (
            <AuthSection />
          ) : section === "remote" ? (
            <RemoteSection />
          ) : section === "voice" ? (
            draft ? <VoiceSection draft={draft} update={update} /> : <Spinner />
          ) : section === "appearance" ? (
            <fieldset>
              <legend className="text-[13px] font-medium">Theme</legend>
              <p className="mb-5 mt-1 text-xs leading-5 text-muted">Choose fabPlane's signature palette or a neutral System theme. Your choice is stored on this device.</p>
              <div className="fd-theme-options">
                {THEME_IDS.map((id) => <label key={id} className="fd-theme-option">
                  <input type="radio" name="appearance-theme" value={id} checked={themeId === id} onChange={() => {
                    setThemeId(id);
                    update((s) => ({ ...s, theme: id.endsWith("-dark") ? "dark" : "light" }));
                  }} />
                  <span className="fd-theme-preview" style={{ background: THEME_BACKGROUNDS[id], color: THEME_FOREGROUNDS[id] }} aria-hidden="true">
                    <span className="fd-theme-preview-sidebar" style={{ background: THEME_PANELS[id] }}><i /><i /><i /></span>
                    <span className="fd-theme-preview-chat"><i /><i /><b style={{ background: id.startsWith("plain") ? "#a78bfa" : "#addb75" }} /></span>
                  </span>
                  <span className="fd-theme-name">{THEME_LABELS[id]}<span className="fd-theme-check" aria-hidden="true" /></span>
                </label>)}
              </div>
            </fieldset>
          ) : section === "language" ? (
            <LanguageSection draft={draft} update={update} />
          ) : section === "privacy" ? (
            <div>
              <Row label="Error reporting" hint="Send crash and error reports to Sentry so bugs get fixed. Reports carry no prompts, board files, tokens or project paths. Turning this off applies immediately; turning it back on applies after a restart.">
                <input type="checkbox" checked={draft.errorReporting} onChange={(e) => update((s) => ({ ...s, errorReporting: e.target.checked }))} />
              </Row>
              <Row label="Share usage data" hint="Share your sessions with us so we can see where fabPlane gets stuck and make it better. This includes your conversations and agent activity, past ones too, and can include your prompts and project files. We keep it private. Turning this off stops future sharing; it doesn't remove what was already shared.">
                <input type="checkbox" checked={usageArchiveAllowed(draft, privacyScreen ?? true)} onChange={(e) => update((s) => ({ ...s, ...usageArchiveChoice(e.target.checked) }))} />
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
        <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
          {patch.isError && <span className="mr-auto text-xs text-danger">{(patch.error as Error).message}</span>}
          {patch.isSuccess && !dirty && <span className="mr-auto text-xs text-success">Saved</span>}
          <Button onClick={reset} disabled={!dirty || patch.isPending}>
            Reset
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || patch.isPending}>
            {patch.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
      {projectId && <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 border-t border-border pt-3">
        <Button size="sm" variant="ghost" disabled={dirty || patch.isPending} onClick={() => {
          if (dirty || patch.isPending) return;
          askAboutSurface({ projectId, label: `Settings · ${LABELS[section]}`, priority: 60, details: JSON.stringify({ window: "Settings", section, sectionLabel: LABELS[section], savedValuesIncluded: false, instruction: "Explain the current settings section. No credentials or configuration values are included in this UI context. Review options with the user before changing configuration." }) }, `Help me understand the ${LABELS[section]} settings and the next checks I should make.`);
          setOpen(false);
        }}><Icon name="sparkles" width={16} height={16} />Ask about these settings</Button>
        {dirty && <span className="text-xs text-muted">Save or reset your changes before leaving Settings to ask.</span>}
      </div>}
    </Dialog>
    <Dialog open={open && confirmClose} onClose={() => setConfirmClose(false)} title="Unsaved changes" className="w-[420px]">
      <p className="text-sm text-muted">Keep editing to save your changes, or discard them and close Settings.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button onClick={() => { reset(); setConfirmClose(false); setOpen(false); }}>Discard changes</Button>
        <Button variant="primary" onClick={() => setConfirmClose(false)}>Keep editing</Button>
      </div>
    </Dialog></>
  );
}

function AuthSection() {
  return <Button onClick={() => useUiStore.getState().setProfileOpen(true)}>Open Profile &amp; account</Button>;
}
