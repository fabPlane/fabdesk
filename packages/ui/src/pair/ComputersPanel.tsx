/**
 * The computers this browser has paired with: switch, remove. `ComputersPanel` is the list;
 * `ComputersDialog` wraps it for the running app (opened from the UserFooter / Settings entry via
 * `useSavedHosts().setComputersDialogOpen`), and `ComputersScreen` is the page the browser client
 * shows before any is connected.
 */
import { Badge, Button, Dialog, EmptyState } from "../components/ui";
import type { SavedHost } from "./hosts";
import { useSavedHosts } from "./store";

export function ComputersPanel({
  onSwitch,
}: {
  onSwitch?: ((host: SavedHost) => void) | undefined;
}) {
  const saved = useSavedHosts((s) => s.saved);
  const remove = useSavedHosts((s) => s.remove);
  const setActive = useSavedHosts((s) => s.setActive);

  if (saved.hosts.length === 0) {
    return (
      <EmptyState title="No computers paired">
        On a computer running fabPlane, open Settings › Remote access › Pair a device and follow the
        web link it shows.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {saved.hosts.map((h) => {
        const active = h.host === saved.active;
        return (
          <div
            key={h.host}
            className="flex items-center gap-3 rounded-lg border border-border bg-panel-2/40 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{h.coreName}</span>
                {active && <Badge tone="success">current</Badge>}
              </div>
              <div className="truncate font-mono text-[11px] text-muted" title={h.host}>
                {h.host}
              </div>
            </div>
            {!active && (
              <Button
                size="sm"
                onClick={() => {
                  setActive(h.host);
                  onSwitch?.(h);
                }}
              >
                Use
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              title="Forget this computer in this browser. Its device token stays listed on the computer until revoked there."
              onClick={() => {
                if (confirm(`Forget ${h.coreName}? This browser will need pairing again.`))
                  remove(h.host);
              }}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div className="mt-1 text-[11px] text-muted">
        Removing a computer here does not revoke its device token; do that on the computer under
        Settings › Remote access.
      </div>
    </div>
  );
}

/** Mounted inside the running browser app; switching reloads so the new computer's client boots clean. */
export function ComputersDialog() {
  const open = useSavedHosts((s) => s.computersDialogOpen);
  const setOpen = useSavedHosts((s) => s.setComputersDialogOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Computers" className="w-[520px]">
      <ComputersPanel onSwitch={() => location.reload()} />
    </Dialog>
  );
}

/** The whole page, before any computer is connected (nothing paired yet, or a bare `/pair`). */
export function ComputersScreen({ onSwitch }: { onSwitch: (host: SavedHost) => void }) {
  const saved = useSavedHosts((s) => s.saved);
  const current = saved.hosts.find((h) => h.host === saved.active);
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6 text-fg">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <div className="mb-1 text-lg font-semibold">fabPlane</div>
        <div className="mb-4 text-sm text-muted">
          This is the browser client. It attaches to a computer running fabPlane over your tailnet;
          nothing runs here.
        </div>
        <ComputersPanel onSwitch={onSwitch} />
        {current && (
          <div className="mt-4">
            <Button variant="primary" onClick={() => onSwitch(current)}>
              Open {current.coreName}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
