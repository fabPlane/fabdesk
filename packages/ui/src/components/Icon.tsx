import type { SVGProps } from "react";

export type IconName =
  | "user"
  | "undo"
  | "redo"
  | "cursor"
  | "hand"
  | "info"
  | "filter"
  | "fileLayers"
  | "download"
  | "route"
  | "checkCircle"
  | "share"
  | "sparkles"
  | "image"
  | "terminal"
  | "tool"
  | "shield"
  | "compose"
  | "copy"
  | "check"
  | "checklist"
  | "warning"
  | "folderOpen"
  | "menu"
  | "sidebar"
  | "panel"
  | "pcb"
  | "schematic"
  | "search"
  | "settings"
  | "plus"
  | "close"
  | "chevronDown"
  | "paperclip"
  | "send"
  | "arrowUp"
  | "queue"
  | "history"
  | "activity"
  | "export"
  | "externalLink"
  | "refresh"
  | "pin"
  | "pinFilled"
  | "more"
  | "moreVertical"
  | "stop"
  | "command"
  | "folder"
  | "trash"
  | "minus"
  | "expand"
  | "play"
  | "pause"
  | "chevronLeft"
  | "chevronRight"
  | "library"
  | "cube"
  | "mic";

/** One stroke language for the desktop chrome. Icons inherit the control's color. */
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    undo: <><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" /></>,
    redo: <><path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" /></>,
    cursor: <path d="m5 3 14 10-7 1-3 7-4-18Z" />,
    hand: <><path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-2c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-3l2 2Z" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    filter: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="var(--fd-panel)" /><circle cx="15" cy="17" r="2" fill="var(--fd-panel)" /></>,
    fileLayers: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5" /><path d="m8 13 4-2 4 2-4 2-4-2Zm0 4 4 2 4-2" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    route: <><circle cx="5" cy="18" r="2" /><circle cx="19" cy="5" r="2" /><path d="M7 18h4a4 4 0 0 0 4-4V9a4 4 0 0 1 2-3" /><path d="m8 8 2-3 2 3" /></>,
    checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    share: <><circle cx="18" cy="5" r="3" /><circle cx="5" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8 10.5 7.5-4M8 13.5l7.5 4" /></>,
    sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="m21 2 .6 1.4L23 4l-1.4.6L21 6l-.6-1.4L19 4l1.4-.6L21 2Z" /></>,
    externalLink: <><path d="M14 3h7v7m0-7L10 14" /><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    tool: <path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    checklist: <><path d="m3 6 1.5 1.5L7 4M10 6h11M3 12h4m3 0h11M3 18h4m3 0h11" /></>,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
    compose: <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" /><path d="m16 3 5 5-10 10-5 1 1-5 9-11Z" /></>,
    folderOpen: <><path d="M3 18V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2" /><path d="M3 18a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4l2-6A1.2 1.2 0 0 0 20.8 11H7.5a2 2 0 0 0-1.9 1.4L3 18Z" /></>,
    trash: <><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></>,
    minus: <path d="M5 12h14" />,
    expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    chevronLeft: <path d="m15 6-6 6 6 6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    folder: <><path d="M3 18V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 9h18" /></>,
    cube: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Z" /><path d="m3 8 9 5 9-5m-9 5v9" /></>,
    library: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    mic: <><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    schematic: <><path d="M3 6h6v12h12M9 12h12M15 6v12" /><circle cx="3" cy="6" r="2" /><circle cx="21" cy="12" r="2" /><circle cx="15" cy="6" r="2" /><circle cx="21" cy="18" r="2" /></>,
    pcb: <><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="8" y="8" width="6" height="6" rx="1" /><path d="M11 3v5m3 3h7M3 11h5m3 3v7m3-4h3v-3" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.07.08-1.85 1.85-.08-.07A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-.95 1.58V20H9v-.02A1.7 1.7 0 0 0 8.05 18.4a1.7 1.7 0 0 0-1.88.34l-.08.07-1.85-1.85.07-.08A1.7 1.7 0 0 0 4.65 15 1.7 1.7 0 0 0 3.07 14H3V10h.07A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.88l-.07-.08 1.85-1.85.08.07A1.7 1.7 0 0 0 8.05 5.6 1.7 1.7 0 0 0 9 4.02V4h6v.02A1.7 1.7 0 0 0 16 5.6a1.7 1.7 0 0 0 1.88-.34l.08-.07 1.85 1.85-.07.08A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.53 1H21v4h-.07A1.7 1.7 0 0 0 19.4 15Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    paperclip: <path d="m20.5 11.5-8.8 8.8a5.2 5.2 0 0 1-7.4-7.4l9.4-9.4a3.5 3.5 0 0 1 5 5l-9.5 9.4a1.8 1.8 0 0 1-2.6-2.6l8.7-8.7" />,
    arrowUp: <path d="M12 19V5m-6 6 6-6 6 6" />,
    queue: <><path d="M5 5h14M12 20V10m-5 5 5-5 5 5" /></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2" /></>,
    send: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    export: <><path d="M12 15V3m-4 4 4-4 4 4" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
    pin: <><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v7" /></>,
    pinFilled: <><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" fill="currentColor" /><path d="M12 15v7" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    moreVertical: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    command: <><path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z" /></>,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
