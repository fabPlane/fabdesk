import type { MechanicalDesign } from "@fabdesk/protocol";

type Entry = { design: MechanicalDesign; label: string };
export const sameEnclosureDesign = (a: MechanicalDesign, b: MechanicalDesign) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Full-design history: removing a board or constraint can be undone along with its settings. */
export class EnclosureHistory {
  private current: MechanicalDesign | null = null;
  private past: Entry[] = [];
  private future: Entry[] = [];
  constructor(private readonly limit = 50) {}
  get undoLabel() {
    return this.past.at(-1)?.label ?? null;
  }
  get redoLabel() {
    return this.future.at(-1)?.label ?? null;
  }
  reset(design: MechanicalDesign) {
    this.current = structuredClone(design);
    this.past = [];
    this.future = [];
  }
  commit(design: MechanicalDesign, label: string): boolean {
    if (!this.current) {
      this.reset(design);
      return false;
    }
    if (sameEnclosureDesign(this.current, design)) return false;
    this.past = [...this.past, { design: this.current, label }].slice(-this.limit);
    this.current = structuredClone(design);
    this.future = [];
    return true;
  }
  undo(): MechanicalDesign | null {
    const entry = this.past.pop();
    if (!entry || !this.current) return null;
    this.future.push({ design: this.current, label: entry.label });
    this.current = entry.design;
    return structuredClone(this.current);
  }
  redo(): MechanicalDesign | null {
    const entry = this.future.pop();
    if (!entry || !this.current) return null;
    this.past.push({ design: this.current, label: entry.label });
    this.current = entry.design;
    return structuredClone(this.current);
  }
}
