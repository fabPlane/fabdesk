import { useEffect } from "react";
import { BOARD_TABS, useUiStore } from "../stores/ui";
import { isMac } from "../util";

export interface ShortcutActions {
  newChat: () => void;
  send?: () => void;
  abort?: () => void;
  pinThread?: () => void;
  branchThread?: () => void;
  openSketch?: () => void;
  openSettings?: () => void;
}

export interface ShortcutDef {
  keys: string;
  label: string;
}

/** Display list for the Settings › Shortcuts tab. `⌘` is rendered as Ctrl on non-mac. */
export function shortcutList(platform?: string): ShortcutDef[] {
  const m = isMac(platform) ? "⌘" : "Ctrl + ";
  const s = isMac(platform) ? "⇧" : "Shift + ";
  return [
    { keys: `${m}K`, label: "Command palette" },
    { keys: `${m}${s}O`, label: "New chat" },
    { keys: `${m}B`, label: "Toggle sidebar" },
    { keys: `${m}${s}B`, label: "Toggle board panel" },
    { keys: `${m}↵`, label: "Send message" },
    { keys: `${m}.`, label: "Abort run" },
    { keys: `${m}${s}P`, label: "Pin / unpin chat" },
    { keys: `${m}${s}D`, label: "Branch chat" },
    { keys: `${m}${s}S`, label: "Sketch pad" },
    { keys: `${m}1…9`, label: "Board tabs" },
    { keys: `${m}/`, label: "Agent & model" },
    { keys: `${m},`, label: "Settings" },
    { keys: isMac(platform) ? "⌥Space" : "Alt + Space", label: "Speak to the agent (hold or toggle)" },
    { keys: "Space", label: "Cinema: play / pause" },
    { keys: "[ / ]", label: "Cinema: previous / next frame" },
    { keys: "Home / End", label: "Cinema: first frame / live" },
  ];
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useShortcuts(actions: ShortcutActions, platform?: string): void {
  useEffect(() => {
    const mac = isMac(platform);
    const handler = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const ui = useUiStore.getState();
      // Account recovery owns its keyboard; never send or navigate the underlying workspace.
      if (ui.sketchOpen || ui.profileOpen) return;
      const key = e.key.toLowerCase();
      const shift = e.shiftKey;
      const run = (fn?: () => void) => {
        if (!fn) return;
        e.preventDefault();
        fn();
      };
      if (key === "k" && !shift) return run(() => ui.setPaletteOpen(!ui.paletteOpen));
      if (key === "o" && shift) return run(actions.newChat);
      if (key === "b" && !shift) return run(ui.toggleSidebar);
      if (key === "b" && shift) return run(ui.toggleBoard);
      if (key === "enter") return run(actions.send);
      if (key === ".") return run(actions.abort);
      if (key === "p" && shift) return run(actions.pinThread);
      if (key === "d" && shift) return run(actions.branchThread);
      if (key === "s" && shift) return run(actions.openSketch ?? (() => ui.setSketchOpen(true)));
      if (key === "/" ) return run(() => ui.setAgentPickerOpen(true));
      if (key === ",") return run(actions.openSettings ?? (() => ui.setSettingsOpen(true)));
      if (!shift && /^[1-9]$/.test(key)) {
        const tab = BOARD_TABS[Number(key) - 1];
        if (tab) return run(() => ui.setBoardTab(tab));
      }
      void isEditable;
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions, platform]);
}
