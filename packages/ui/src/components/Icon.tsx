import type { SVGProps } from "react";

export type IconName =
  | "menu"
  | "sidebar"
  | "panel"
  | "search"
  | "settings"
  | "plus"
  | "close"
  | "chevronDown"
  | "paperclip"
  | "send"
  | "pin"
  | "more"
  | "stop"
  | "command";

/** One stroke language for the desktop chrome. Icons inherit the control's color. */
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.07.08-1.85 1.85-.08-.07A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-.95 1.58V20H9v-.02A1.7 1.7 0 0 0 8.05 18.4a1.7 1.7 0 0 0-1.88.34l-.08.07-1.85-1.85.07-.08A1.7 1.7 0 0 0 4.65 15 1.7 1.7 0 0 0 3.07 14H3V10h.07A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.88l-.07-.08 1.85-1.85.08.07A1.7 1.7 0 0 0 8.05 5.6 1.7 1.7 0 0 0 9 4.02V4h6v.02A1.7 1.7 0 0 0 16 5.6a1.7 1.7 0 0 0 1.88-.34l.08-.07 1.85 1.85-.07.08A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.53 1H21v4h-.07A1.7 1.7 0 0 0 19.4 15Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    paperclip: <path d="m20.5 11.5-8.8 8.8a5.2 5.2 0 0 1-7.4-7.4l9.4-9.4a3.5 3.5 0 0 1 5 5l-9.5 9.4a1.8 1.8 0 0 1-2.6-2.6l8.7-8.7" />,
    send: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    pin: <><path d="m8 4 8 8M14 3l7 7-3 1-3 3-2 7-2-8-3-3-4-1 3-3 1-3Z" /></>,
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
