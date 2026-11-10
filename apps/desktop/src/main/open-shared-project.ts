import { parseSharedProjectHref, parseContributionProjectHref, type OpenSharedProjectIntent } from "@fabdesk/protocol";

/** Retain a validated link through cold startup until the renderer is ready. */
export class OpenSharedProjectQueue {
  private pending: OpenSharedProjectIntent | null = null;
  offer(raw: string | readonly string[]): OpenSharedProjectIntent | null {
    for (const arg of typeof raw === "string" ? [raw] : raw) {
      const intent = parseSharedProjectHref(arg) ?? parseContributionProjectHref(arg);
      if (intent) {
        this.pending = intent;
        return intent;
      }
    }
    return null;
  }
  take(): OpenSharedProjectIntent | null {
    const intent = this.pending;
    this.pending = null;
    return intent;
  }
}
