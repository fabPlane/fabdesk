import { Command } from "cmdk";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Dialog } from "../components/ui";
import { Icon } from "../components/Icon";

type Props = {
  reference: string | null;
  references: readonly string[];
  values: ReadonlyMap<string, string>;
  disabled?: boolean;
  onSelect: (ref: string) => void;
  onClear: () => void;
  children?: ReactNode;
};

export function PartPicker({ reference, references, values, disabled, onSelect, onClear, children }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return <>
    <Button ref={trigger} size="sm" variant="secondary" className="fd-part-picker" value={reference ?? ""} aria-haspopup="dialog" aria-expanded={open}
      aria-label={reference ? `Find part, selected ${reference}` : "Find part"} disabled={disabled || !references.length} onClick={() => setOpen(true)}>
      <Icon name="search" width={14} height={14} /><span>{reference || "Find part"}</span>
    </Button>
    <span className="sr-only" role="status">{reference ? `${reference} selected across views` : "No part selected"}</span>
    {children}
    {reference && <Button size="sm" variant="ghost" aria-label="Clear selection" onClick={() => {
      onClear();
      trigger.current?.focus();
    }}>Clear</Button>}
    {open && createPortal(<Dialog open onClose={close} title="Find part" className="w-[400px] max-w-full">
      <Command label="Find part" filter={(ref, input, keywords) => {
        const term = input.trim().toLowerCase(), key = ref.toLowerCase();
        if (key === term) return 1;
        if (key.startsWith(term)) return .9;
        return key.includes(term) || keywords?.some(value => value.toLowerCase().includes(term)) ? .7 : 0;
      }}>
        <Command.Input aria-label="Search by reference or value" placeholder="Search by reference or value…" className="fd-part-search" />
        <Command.List className="fd-part-results">
          <Command.Empty>No matching parts</Command.Empty>
          {references.map(ref => {
            const value = values.get(ref);
            return <Command.Item key={ref} value={ref} keywords={value ? [value] : []} onSelect={() => {
              if (!disabled) onSelect(ref);
              close();
            }}><strong>{ref}</strong>{value && <span>{value}</span>}</Command.Item>;
          })}
        </Command.List>
      </Command>
    </Dialog>, document.body)}
  </>;
}
