import { parseSharedProjectHref } from "@fabdesk/protocol";

/** Retain a validated link through cold startup until the renderer is ready. */
export class OpenSharedProjectQueue {
  private pending: { shareId: string } | null = null;
  offer(raw: string | readonly string[]): { shareId: string } | null {
    for (const arg of typeof raw === "string" ? [raw] : raw) {
      const intent = parseSharedProjectHref(arg);
      if (intent) {
        this.pending = intent;
        return intent;
      }
    }
    return null;
  }
  take(): { shareId: string } | null {
    const intent = this.pending;
    this.pending = null;
    return intent;
  }
}
