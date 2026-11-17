/**
 * Owner authority in the review. An agent records `by: "owner"` only by asking the person through the run's approval
 * card (fabdesk's desktop or a paired device); the card's outcome is stored beside the disposition, decision or
 * delegation. Without it, the record is the agent's claim and is judged by the agent's rules.
 *
 * This keeps an agent from waiving its own findings by saying the owner agreed. It cannot stop a process that runs as
 * the same OS user from editing the review files directly; a hand-edited record is visible in the report.
 */
import { createHash } from "node:crypto";
import type { Intent, OwnerApproval } from "./types";

/** An approval card the person approved, at the desktop or on a paired device (not a timeout). */
export function ownerConfirmed(a: OwnerApproval | null | undefined): boolean {
  return a?.approved === true && (a.by === "desktop" || a.by === "device") && typeof a.requestId === "string" && a.requestId.length > 0;
}

/** The hash an approval of the intent's preferences is bound to. */
export function preferencesSha(preferences: Intent["preferences"]): string {
  return createHash("sha256").update(JSON.stringify(preferences ?? {})).digest("hex");
}

/** The owner approved these exact preferences; otherwise the defaults (ask the owner) apply. */
export function preferencesConfirmed(intent: Intent | null): boolean {
  const a = intent?.preferences_approval;
  return !!intent && ownerConfirmed(a) && a!.sha256 === preferencesSha(intent.preferences);
}
