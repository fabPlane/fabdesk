import type { ReleaseNotes } from "@fabdesk/protocol";
import { useCore } from "@fabdesk/client-core";
import { Dialog } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { useI18n } from "../i18n";

/** True when this build has notes the user has not opened yet. */
export function hasUnseenReleaseNotes(notes: ReleaseNotes | undefined, seenId: string | null): boolean {
  return notes !== undefined && notes.id !== seenId;
}

/** Opens the dialog; undefined when the build has no notes. Closing it marks them read. */
export function useOpenWhatsNew(): (() => void) | undefined {
  const { host } = useCore();
  const setOpen = useUiStore((s) => s.setWhatsNewOpen);
  return host.releaseNotes ? () => setOpen(true) : undefined;
}

/** Blue "What's new" link in the top bar; gone once this build's notes have been opened. */
export function WhatsNewLink() {
  const { t } = useI18n();
  const { host } = useCore();
  const seenId = useUiStore((s) => s.whatsNewSeenId);
  const open = useOpenWhatsNew();
  if (!open || !hasUnseenReleaseNotes(host.releaseNotes, seenId)) return null;
  return (
    <button
      type="button"
      data-testid="whats-new-link"
      onClick={open}
      className="cursor-pointer px-1 text-[11px] font-medium text-link hover:underline"
    >
      {t("whatsNew.link")}
    </button>
  );
}

export function WhatsNewDialog() {
  const { t, formatDate: formatLocaleDate } = useI18n();
  const { host } = useCore();
  const open = useUiStore((s) => s.whatsNewOpen);
  const setOpen = useUiStore((s) => s.setWhatsNewOpen);
  const markSeen = useUiStore((s) => s.markWhatsNewSeen);
  const notes = host.releaseNotes;
  if (!notes) return null;
  // Marked read on close, not on open, so the top-bar link is still there when the dialog records
  // its opener; it then disappears, and focus moves to the next top-bar control instead.
  const close = () => {
    markSeen(notes.id);
    setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("whatsNew.title")}
      className="w-[560px]"
      fallbackFocus={() => document.querySelector<HTMLElement>("[data-topbar-actions] button")}
    >
      <div className="text-sm" data-testid="whats-new-dialog">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="font-semibold">{formatLocaleDate(notes.date)}</h3>
          {notes.version && <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{notes.version}</span>}
        </div>
        {notes.sections.map((section) => (
          <div key={section.title} className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{section.title}</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 leading-relaxed">
              {section.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
