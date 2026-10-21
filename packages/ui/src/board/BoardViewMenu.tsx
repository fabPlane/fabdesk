import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { BOARD_TABS, BOARD_TAB_LABELS, type BoardTab } from "../stores/ui";
import "./board-view-menu.css";

/** Compact alternative to the tab strip; keeps every section and its shortcut discoverable. */
export function BoardViewMenu({ value, onChange, modifier }: {
  value: BoardTab; onChange: (tab: BoardTab) => void; modifier: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const id = useId();
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => setOpen(false), [value]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const panel = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8)),
      top: anchor.bottom + panel.height + 6 <= window.innerHeight - 8
        ? anchor.bottom + 6 : Math.max(8, anchor.top - panel.height - 6),
    });
    menu.current.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    search.current = { text: "", at: 0 };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const resize = () => {
      const hadFocus = menu.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocus) {
        if (trigger.current?.getClientRects().length) trigger.current.focus();
        else trigger.current?.closest(".fd-board-controls")?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
      }
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      dismiss();
    };
    const controls = trigger.current?.closest(".fd-board-controls");
    // Ignore the observer's initial notification; a panel resize then closes stale positioning.
    let initialized = false;
    const widthObserver = new ResizeObserver(() => { if (initialized) resize(); initialized = true; });
    if (controls) widthObserver.observe(controls);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      widthObserver.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return <div className="fd-board-compact" data-testid="board-view-menu">
    <button ref={trigger} type="button" className="fd-board-view-trigger" aria-label={`Board view: ${BOARD_TAB_LABELS[value]}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
    }}>
      <Icon name="library" width={15} height={15} />
      <span>{BOARD_TAB_LABELS[value]}</span>
      <Icon name="chevronDown" className="fd-board-view-chevron" width={14} height={14} />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label="Board sections" className="fd-board-view-menu fd-elevated" style={position} onKeyDown={event => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === "ArrowDown") next = (current + 1) % items.length;
      if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); items[next]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(true);
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
        const now = Date.now();
        const letter = event.key.toLocaleLowerCase();
        search.current = { text: now - search.current.at < 650 ? search.current.text + letter : letter, at: now };
        const match = items.find(item => item.dataset.label?.toLocaleLowerCase().startsWith(search.current.text));
        if (match) { event.preventDefault(); match.focus(); }
      }
    }}>
      <div className="fd-board-view-caption" aria-hidden="true">Board sections</div>
      {BOARD_TABS.map((tab, index) => <button key={tab} type="button" role="menuitemradio" aria-checked={tab === value} tabIndex={-1} data-label={BOARD_TAB_LABELS[tab]} className="fd-board-view-option" onClick={() => { onChange(tab); close(true); }}>
        <span className="fd-board-view-check">{tab === value && <Icon name="check" width={15} height={15} />}</span>
        <span>{BOARD_TAB_LABELS[tab]}</span>
        <kbd aria-hidden="true">{modifier} {index + 1}</kbd>
      </button>)}
    </div>, document.body)}
  </div>;
}
