import { Command } from "cmdk";
import { useCallback } from "react";
import { useAppActions } from "../app/useAppActions";
import { Dialog, Kbd } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { useProjects, useThreads } from "../hooks/queries";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore } from "../stores/ui";
import { modKey } from "../util";

export function CommandPalette() {
  const { host } = useCore();
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleBoard = useUiStore((s) => s.toggleBoard);
  const actions = useAppActions();
  const threads = useThreads();
  const projects = useProjects();
  const close = useCallback(() => setOpen(false), [setOpen]);
  const mod = modKey(host.platform);
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <Dialog open={open} onClose={close} bare className="w-[560px] max-w-full">
      <Command label="Command palette" className="flex max-h-[70vh] flex-col">
        <Command.Input
          autoFocus
          placeholder="Type a command or search threads..."
          className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted"
        />
        <Command.List className="min-h-0 flex-1 overflow-auto p-1.5">
          <Command.Empty>No results.</Command.Empty>
          <Command.Group heading="Actions">
            <Command.Item value="new chat" onSelect={pick(actions.newChat)}>
              New chat <span className="ml-auto"><Kbd>{mod}Shift+O</Kbd></span>
            </Command.Item>
            <Command.Item value="route board" onSelect={pick(() => void actions.routeBoard())}>
              Route board
            </Command.Item>
            <Command.Item value="run drc" onSelect={pick(() => void actions.runDrc())}>
              Run DRC
            </Command.Item>
            <Command.Item value="render board" onSelect={pick(() => void actions.renderBoard())}>
              Render board
            </Command.Item>
            <Command.Item value="pin thread" onSelect={pick(() => void actions.pinThread())}>
              Pin / unpin thread <span className="ml-auto"><Kbd>{mod}Shift+P</Kbd></span>
            </Command.Item>
            <Command.Item value="branch thread" onSelect={pick(() => void actions.branchThread())}>
              Branch thread <span className="ml-auto"><Kbd>{mod}Shift+D</Kbd></span>
            </Command.Item>
            <Command.Item value="sketch" onSelect={pick(actions.openSketch)}>
              Open sketch pad <span className="ml-auto"><Kbd>{mod}Shift+S</Kbd></span>
            </Command.Item>
            <Command.Item value="settings" onSelect={pick(actions.openSettings)}>
              Settings <span className="ml-auto"><Kbd>{mod},</Kbd></span>
            </Command.Item>
            <Command.Item value="toggle sidebar" onSelect={pick(toggleSidebar)}>
              Toggle sidebar <span className="ml-auto"><Kbd>{mod}B</Kbd></span>
            </Command.Item>
            <Command.Item value="toggle board panel" onSelect={pick(toggleBoard)}>
              Toggle board panel <span className="ml-auto"><Kbd>{mod}Shift+B</Kbd></span>
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Board tabs">
            {BOARD_TABS.map((tab, i) => (
              <Command.Item key={tab} value={`tab ${BOARD_TAB_LABELS[tab]}`} onSelect={pick(() => setBoardTab(tab))}>
                {BOARD_TAB_LABELS[tab]} <span className="ml-auto"><Kbd>{mod}{i + 1}</Kbd></span>
              </Command.Item>
            ))}
          </Command.Group>
          {(projects.data?.length ?? 0) > 0 && (
            <Command.Group heading="Projects">
              {projects.data!.map((p) => (
                <Command.Item key={p.id} value={`project ${p.name}`} onSelect={pick(() => setActiveProject(p.id))}>
                  {p.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {(threads.data?.length ?? 0) > 0 && (
            <Command.Group heading="Threads">
              {threads.data!.slice(0, 50).map((t) => (
                <Command.Item key={t.id} value={`thread ${t.title} ${t.id}`} onSelect={pick(() => setActiveThread(t.id))}>
                  <span className="truncate">{t.title || "Untitled"}</span>
                  {t.pinned && <span className="ml-auto text-[10px] text-muted">pinned</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </Dialog>
  );
}
