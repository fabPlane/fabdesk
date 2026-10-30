/** User-facing recovery guidance. Keep original errors available for diagnostics. */
export type ErrorAction = "projects" | "agents" | "auth" | "kicad";
export interface ErrorHelp {
  title: string;
  message: string;
  severity?: "warning";
  action?: ErrorAction;
  command?: string;
}
export interface ErrorContext {
  status?: number;
  path?: string;
  agentId?: string;
}

export function errorPayload(input: unknown): { raw: string; message: string; code?: string } {
  let raw: string;
  try {
    raw = input instanceof Error
      ? ("rawMessage" in input && typeof input.rawMessage === "string" ? input.rawMessage : input.message)
      : typeof input === "string" ? input : JSON.stringify(input) ?? "";
  } catch { raw = "Unrecognized error details"; }
  try {
    const body: unknown = JSON.parse(raw);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      const nested = b.error && typeof b.error === "object" ? b.error as Record<string, unknown> : null;
      const message = typeof b.message === "string" ? b.message
        : typeof nested?.message === "string" ? nested.message
        : typeof b.error === "string" ? b.error : raw;
      const code = typeof b.code === "string" ? b.code
        : typeof nested?.code === "string" ? nested.code
        : typeof b.error === "string" && /^[a-z_]+$/.test(b.error) ? b.error : undefined;
      return { raw, message, ...(code ? { code } : {}) };
    }
  } catch { /* Plain-text errors from CLIs and older servers. */ }
  return { raw, message: raw };
}

const agentNames: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", grok: "Grok" };
const loginCommands: Record<string, string> = { claude: "claude auth login", codex: "codex login", cursor: "agent login", grok: "grok login" };

export function errorHelp(input: unknown, context: ErrorContext = {}): ErrorHelp {
  const { message, code } = errorPayload(input);
  const text = message.replace(/^\s*⚠\s*/, "").trim();
  const status = context.status ?? (input instanceof Error && "status" in input && typeof input.status === "number" ? input.status : undefined);
  const agent = context.agentId ? agentNames[context.agentId] ?? "The selected agent" : "The selected agent";
  const command = context.agentId ? loginCommands[context.agentId] : undefined;
  if (/^(?:cancelled|canceled|AbortError: (?:the operation was aborted|aborted))\.?$/i.test(text)) return {
    title: "Task cancelled",
    message: "This task stopped. Files saved before cancellation may remain; review the outputs before starting it again.",
    severity: "warning",
  };
  if (code === "approval_not_supported" || text === "agent cannot run supervised") return {
    title: "Approval pauses are unavailable for this agent",
    message: "Keep the current permission setting to continue. Your selected agent and model have not changed.",
  };
  if (text.startsWith("No answer was received for the question.")) return {
    title: "The question was not answered",
    message: "Send a message to ask the question again, then choose an option or type your answer.",
  };
  if (text.startsWith("Windows denied a Codex overlay symlink (EPERM).")) return {
    title: "Codex is using your shared settings",
    message: "Windows blocked the link needed to keep this project’s Codex settings separate. Codex can continue with your usual login, but it may update your shared settings and app data. Extra integrations are disabled, but complete separation from your usual setup is not guaranteed. If you need separate settings, stop this run and ask your administrator to allow symbolic links, then restart fabPlane.",
    severity: "warning",
  };
  if (code === "project_not_found") return {
    title: "Choose a project again",
    message: "The selected project is no longer available. Choose an existing project or create a new one, then send your message again.", action: "projects",
  };
  if (code === "parent_thread_not_found" || code === "thread_not_found") return {
    title: "This chat is no longer available",
    message: "Open an existing chat or start a new one, then send your message again.",
  };
  if (/FOREIGN KEY constraint failed/i.test(text)) return {
    title: "A linked item is no longer available",
    message: "The project, chat, or folder this action refers to could not be found. Reopen the project or start a new chat, then try again.", action: "projects",
  };
  if (code === "cloud_signed_out") return {
    title: "Sign in to fabPlane",
    message: "Your fabPlane session has ended. Open Settings → Account and sign in again, then retry.", action: "auth",
  };
  if (/OAuth session expired|refresh[_ ]token.*(?:expired|invalid|reused)|could not be refreshed|not logged in|authentication[_ ](?:error|failed|required)|failed to authenticate|invalid (?:API key|authentication)|invalid_api_key/i.test(text) || (context.agentId && /^(?:API Error:\s*)?401\b/.test(text))) return {
    title: `${agent} needs you to sign in again`,
    message: `Your agent login has expired or is not valid. Sign in to ${context.agentId ? agent : "the selected agent"} again, then resend your message. You can also choose another signed-in agent below the message box.`,
    action: "agents", ...(command ? { command } : {}),
  };
  if (/insufficient_quota|quota exceeded|credit balance.*(?:low|insufficient)|insufficient credits|billing.*(?:limit|hard)|usage limit|out of credits/i.test(text)) return {
    title: "Your agent account has reached its usage limit",
    message: "Check your agent account’s usage and billing. Wait for your allowance to reset, add credits if needed, or choose another agent.", action: "agents",
  };
  if (status === 429 || /rate[_ -]?limit|too many requests/i.test(text)) return {
    title: "Too many requests right now",
    message: "Wait a little before trying again. If this keeps happening, check your account’s usage limits.",
  };
  if (/context_length_exceeded|maximum context length|prompt is too long|too many tokens/i.test(text)) return {
    title: "This conversation is too long for the selected model",
    message: "Start a new chat with a short summary, or shorten your message and remove large attachments, then send again.",
  };
  if (/model_not_found|model.*(?:does not exist|not found|not available|not supported|do not have access)|unsupported model/i.test(text)) return {
    title: "The selected model is unavailable",
    message: "Choose a different model below the message box. If you expected access, check your agent account’s plan.", action: "agents",
  };
  if (/core offline|core disconnected/i.test(text)) return {
    title: "Your computer is disconnected",
    message: "Open fabPlane on the computer you paired with and check that it is online, then reconnect.",
  };
  if (/KiCad was unable to open this file because it was created with a more recent version|file format dated .* or later/i.test(text)) return {
    title: "KiCad cannot open this board format",
    message: "Choose a KiCad build that supports this file format in Settings → KiCad. Nightly builds can report the same version number while supporting different file dates. Your native sources and previous outputs are preserved.", action: "kicad",
  };
  if (/MCP server.*(?:failed to connect|not connected)|PCB bridge.*(?:unavailable|not running|failed)|FabPCB.*unavailable/i.test(text)) return {
    title: "The design tools are not connected",
    message: "Restart fabPlane and try again. If board tools still fail, check the KiCad setup in Settings.", action: "kicad",
  };
  if (/failed to start.*(?:ENOENT|not found)|(?:claude|codex|cursor|grok).*could not be started|agent.*not installed/i.test(text)) return {
    title: `${agent} could not start`,
    message: "Open Settings → Agents to check that the agent is installed and its program location is correct, then try again.", action: "agents",
  };
  if (/(?:claude|codex|cursor|grok).*exited with code/i.test(text)) return {
    title: `${agent} stopped before finishing`,
    message: "Open Settings → Agents and check that the agent is installed and signed in. Then resend your message. If it fails again, share the technical details with support.", action: "agents",
  };
  if (/ENOSPC|SQLITE_FULL|database or disk is full|no space left on device/i.test(text)) return {
    title: "Your disk is full",
    message: "Free up space on the drive containing your project and app data, then try again.",
  };
  if (/SQLITE_BUSY|database is locked/i.test(text)) return {
    title: "App data is busy",
    message: "Wait a moment and try again. If this continues, close other fabPlane windows and restart the app.",
  };
  if (/SQLITE_CORRUPT|database disk image is malformed/i.test(text)) return {
    title: "Saved app data could not be read",
    message: "Stop retrying and contact support with the technical details. Keep your app data so it can be recovered.",
  };
  if (/EACCES|EPERM|permission denied|read-only file system/i.test(text)) return {
    title: "Access to a file or folder was denied",
    message: "Choose a folder you can write to, or check its permissions, then try again.",
  };
  if (code === "invalid_parent_directory") return {
    title: "Choose a different folder",
    message: "The project location is missing or is not a folder. Choose an existing folder you can write to.",
  };
  if (/board\.kicad_(?:pcb|sch).*(?:not found|does not exist)/i.test(text)) return {
    title: "There is no board to work on yet",
    message: "Ask the agent to build the board first, then retry this action.",
  };
  if (/ENOENT|no such file or directory/i.test(text)) return {
    title: "A required file or folder is missing",
    message: "Check that the file still exists and select it again. If it was on an external drive, reconnect the drive first.",
  };
  if (/an agent run is already active/i.test(text)) return {
    title: "An agent is already working here",
    message: "Wait for the current run to finish, or stop it before starting another run on this project.",
  };
  if (/ETIMEDOUT|timed? out|TimeoutError/i.test(text) || status === 504 || status === 408) return {
    title: "The request took too long",
    message: "Check whether the action completed before retrying. If it did not, check your connection and try again.",
  };
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Failed to fetch|fetch failed|NetworkError|network request failed|Load failed/i.test(text)) return {
    title: "Could not connect",
    message: "Check your connection and that fabPlane is running. Reconnect or restart the app, then try again.",
  };
  if (status === 401) return {
    title: "Your connection is no longer authorized",
    message: "Restart fabPlane to reconnect. If you are using a paired device, reconnect or pair it again.",
  };
  if (status === 403) return {
    title: "You do not have access to this action",
    message: "Check that you are using the right account and have permission to access this item.",
  };
  if (status === 404) return {
    title: "This item is no longer available",
    message: "Refresh the list and select the project, chat, or file again. It may have been moved or deleted.",
  };
  if (status === 409) return {
    title: "This item has changed",
    message: "Refresh it and check its current state before trying again.",
  };
  if (status === 502 || status === 503 || status === 529 || /overloaded_error|service (?:temporarily )?unavailable/i.test(text)) return {
    title: "The service is temporarily unavailable",
    message: "Wait a moment and try again. If it continues, check the service’s status or choose another agent.",
  };
  if (code === "invalid_args" || status === 400 || status === 422) return {
    title: "Some information needs checking",
    message: "Check the values you entered and any selected files, then try again.",
  };
  if (code === "internal" || (status !== undefined && status >= 500) || /exited with code|parser error|^\s*[\[{<]|^\w*(?:Error|Exception):/.test(text)) return {
    title: "The action could not be completed",
    message: "Check whether anything changed before retrying. If it fails again, restart fabPlane and share the technical details with support.",
  };
  return { title: "The action could not be completed", message: text && /\s/.test(text)
    ? `${text} Check the details and try again. If this continues, share the technical details with support.`
    : "Try again. If this continues, restart fabPlane and share the technical details with support." };
}

export function errorMessage(input: unknown, context: ErrorContext = {}): string {
  const help = errorHelp(input, context);
  return `${help.title}. ${help.message}${help.command ? ` Run ${help.command} in a terminal to sign in.` : ""}`;
}

/** Only classify standalone failures, never arbitrary prose discussing an error. */
export function agentErrorText(text: string): string | null {
  const clean = text.trim();
  const chunks = clean.split(/\n\s*\n/).map((part) => part.replace(/^⚠\s*/, "").trim());
  const unique = [...new Set(chunks)];
  if (unique.length !== 1) return null;
  const raw = unique[0]!;
  // A core-generated warning marker identifies a failure; plain assistant prose does not.
  if (clean.startsWith("⚠ ") && /^(?:Error:|MCP server|No answer was received for the question\.)/i.test(raw)) return raw;
  if (raw.startsWith("Windows denied a Codex overlay symlink (EPERM).")) return raw;
  const failure = /^(?:Failed to authenticate:|OAuth session expired|API Error:|Not logged in|authentication_error|rate_limit_error|insufficient_quota|quota exceeded|credit balance is too low|prompt is too long|model_not_found|context_length_exceeded|failed to start|(?:claude|codex|cursor|grok) (?:could not be started|exited with code)|Queued message could not be sent:|SQLITE_|FOREIGN KEY constraint failed|database is locked|ENOSPC|EACCES|EPERM|ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Failed to fetch|fetch failed)/i;
  return failure.test(raw) ? raw : null;
}

/** Preserve partial work when a run ends with a separate error paragraph. */
export function splitAgentError(text: string): { before: string; error: string; after?: string } | null {
  // This nonfatal setup notice is followed by the agent's normal reply in the same text part.
  const firstParagraphEnd = text.indexOf("\n\n");
  if (firstParagraphEnd >= 0) {
    const first = text.slice(0, firstParagraphEnd).replace(/^\s*⚠\s*/, "").trim();
    if (first.startsWith("Windows denied a Codex overlay symlink (EPERM)."))
      return { before: "", error: first, after: text.slice(firstParagraphEnd + 2) };
  }
  const whole = agentErrorText(text);
  if (whole) return { before: "", error: whole };
  const marker = text.lastIndexOf("\n\n⚠ ");
  if (marker < 0) return null;
  const error = agentErrorText(text.slice(marker + 2));
  return error ? { before: text.slice(0, marker), error } : null;
}
