import type { Message } from "@fabdesk/protocol";
import { splitAgentError } from "@fabdesk/client-core";

/** Preserve the trailing answer; never invent a final answer when a run ends in a tool. */
export function splitCompletedActivity(messages: Message[], interrupted = false): { history: Message[]; answer: Message | null } {
  const last = messages.at(-1);
  if (!last) return { history: messages, answer: null };
  // A failed run's recovery instructions must remain visible outside collapsed activity.
  const finalText = last.parts.length ? last.parts.at(-1) : null;
  const failure = finalText?.type === "text" ? splitAgentError(finalText.text) : !last.parts.length ? splitAgentError(last.contentMd) : null;
  if (interrupted && !failure) return { history: messages, answer: null };
  if (!last.parts.length) return last.contentMd.trim()
    ? { history: messages.slice(0, -1), answer: last }
    : { history: messages, answer: null };
  let boundary = last.parts.length;
  while (boundary > 0 && ["text", "image"].includes(last.parts[boundary - 1]!.type)) boundary--;
  const tail = last.parts.slice(boundary);
  if (!tail.length) return { history: messages, answer: null };
  const history = messages.slice(0, -1);
  if (boundary) history.push({ ...last, parts: last.parts.slice(0, boundary), contentMd: "" });
  return { history, answer: { ...last, parts: tail, contentMd: tail.filter(p => p.type === "text").map(p => p.text).join("\n\n") } };
}
