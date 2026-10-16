import type { SVGProps } from "react";

export type IconName =
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
  | "search"
  | "settings"
  | "plus"
  | "close"
  | "chevronDown"
  | "paperclip"
  | "send"
  | "export"
  | "pin"
  | "pinFilled"
  | "more"
  | "stop"
  | "command"
  | "folder"
  | "minus"
  | "play"
  | "pause"
  | "chevronLeft"
  | "chevronRight"
  | "library";

/** One stroke language for the desktop chrome. Icons inherit the control's color. */
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
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
    minus: <path d="M5 12h14" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    chevronLeft: <path d="m15 6-6 6 6 6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    folder: <><path d="M3 18V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 9h18" /></>,
    library: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    pcb: <><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="8" y="8" width="6" height="6" rx="1" /><path d="M11 3v5m3 3h7M3 11h5m3 3v7m3-4h3v-3" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.07.08-1.85 1.85-.08-.07A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-.95 1.58V20H9v-.02A1.7 1.7 0 0 0 8.05 18.4a1.7 1.7 0 0 0-1.88.34l-.08.07-1.85-1.85.07-.08A1.7 1.7 0 0 0 4.65 15 1.7 1.7 0 0 0 3.07 14H3V10h.07A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.88l-.07-.08 1.85-1.85.08.07A1.7 1.7 0 0 0 8.05 5.6 1.7 1.7 0 0 0 9 4.02V4h6v.02A1.7 1.7 0 0 0 16 5.6a1.7 1.7 0 0 0 1.88-.34l.08-.07 1.85 1.85-.07.08A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.53 1H21v4h-.07A1.7 1.7 0 0 0 19.4 15Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    paperclip: <path d="m20.5 11.5-8.8 8.8a5.2 5.2 0 0 1-7.4-7.4l9.4-9.4a3.5 3.5 0 0 1 5 5l-9.5 9.4a1.8 1.8 0 0 1-2.6-2.6l8.7-8.7" />,
    send: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    export: <><path d="M12 15V3m-4 4 4-4 4 4" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
    pin: <><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v7" /></>,
    pinFilled: <><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" fill="currentColor" /><path d="M12 15v7" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    command: <><path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z" /></>,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
