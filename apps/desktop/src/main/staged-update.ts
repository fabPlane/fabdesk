import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { compareVersions } from "@fabdesk/updates";
import type { ReleaseAsset, UpdateDownloadState } from "@fabdesk/protocol";
import type { FeedUpdateInfo } from "./update-feed";

export interface UpdateOffer { version: string; asset: ReleaseAsset; info: FeedUpdateInfo }
interface Target { version: string; sha256: string }
type Receipt = Target & { phase: "accepted" | "applying" };
type Downloading = Extract<UpdateDownloadState, { state: "downloading" }>;
type Staged = Extract<UpdateDownloadState, { state: "done" }>;

export interface StagedUpdateHost {
  version: string;
  recordPath: string;
  offer(): Promise<UpdateOffer>;
  stage(offer: UpdateOffer, signal: AbortSignal, progress: (stats: Pick<Downloading, "received" | "total" | "percent" | "bytesPerSecond">) => void, verifying: () => void): Promise<string>;
  notify(state: UpdateDownloadState): void;
  quit(): void;
  install(job: Staged, restart: boolean): void;
}

function readReceipt(path: string, current: string): Receipt | null {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (typeof value?.version !== "string" || compareVersions(value.version, current) <= 0) {
    rmSync(path, { force: true });
    return null;
  }
  if (value.phase === "accepted" && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sha256)) return value;
  // Older versions left a {version} record when an installation was attempted.
  return { version: value.version, sha256: "", phase: "applying" };
}

function saveReceipt(path: string, value: Receipt): void {
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

export function saveAcceptedUpdate(recordPath: string, target: Target): void {
  saveReceipt(recordPath, { ...target, phase: "accepted" });
}

/** Electron emits before-quit synchronously from app.quit(). A new OS quit after a
 * window veto starts a fresh attempt, without inheriting a canceled Restart request. */
export class RestartOnQuit {
  #requested = false;
  relaunch = false;
  request(quit: () => void): void {
    this.#requested = true;
    try { quit(); } finally { this.#requested = false; }
  }
  begin(): void { this.relaunch = this.#requested; }
}

/** Only an accepted release can stage itself. The final Electron quit event is after
 * every cancellable window close and after the application's child processes stop. */
export class StagedUpdate {
  #state: UpdateDownloadState = { state: "idle" };
  #pending: Promise<UpdateDownloadState> | null = null;
  #abort: AbortController | null = null;
  #restart = new RestartOnQuit();

  constructor(private readonly host: StagedUpdateHost) {}

  state(): UpdateDownloadState { return this.#state; }

  #set(state: UpdateDownloadState): void {
    this.#state = state;
    this.host.notify(state);
  }

  async restore(): Promise<void> {
    const receipt = readReceipt(this.host.recordPath, this.host.version);
    if (!receipt) return;
    if (receipt.phase === "applying") {
      this.#set({ state: "error", version: receipt.version, message: "The last update did not finish. Your current version is available. Retry the update." });
      return;
    }
    await this.#download(receipt);
  }

  download(): Promise<UpdateDownloadState> { return this.#download(); }

  #download(accepted?: Target): Promise<UpdateDownloadState> {
    if (this.#pending) return this.#pending;
    if (this.#state.state === "done" || this.#state.state === "installing") return Promise.resolve(this.#state);
    const abort = new AbortController();
    this.#abort = abort;
    this.#pending = this.#stage(abort.signal, accepted).finally(() => {
      this.#pending = null;
      this.#abort = null;
    });
    return this.#pending;
  }

  async #stage(signal: AbortSignal, accepted?: Target): Promise<UpdateDownloadState> {
    let version = accepted?.version;
    let recorded = false;
    try {
      const offer = await this.host.offer();
      signal.throwIfAborted();
      const target = { version: offer.version, sha256: offer.asset.sha256 };
      version = offer.version;
      if (accepted && (accepted.version !== target.version || accepted.sha256 !== target.sha256)) {
        // Consent for cached bytes cannot move to a newly published release.
        rmSync(this.host.recordPath, { force: true });
        return this.#state;
      }
      saveAcceptedUpdate(this.host.recordPath, target);
      recorded = true;
      const file = { version, filename: offer.asset.filename };
      this.#set({ state: "downloading", ...file, received: 0, total: offer.asset.size, percent: 0, bytesPerSecond: null });
      const path = await this.host.stage(offer, signal, (progress) => {
        if (!signal.aborted && this.#state.state === "downloading") this.#set({ state: "downloading", ...file, ...progress });
      }, () => this.#set({ state: "verifying", ...file }));
      signal.throwIfAborted();
      this.#set({ state: "done", ...file, path, sha256: target.sha256, restart: true });
    } catch (error) {
      if (signal.aborted) this.#set({ state: "idle" });
      else {
        // A staging error has an explicit Retry. A process interrupted mid-download still
        // owns its receipt and can resume. Do not repeat a known bad download on every launch.
        if (recorded) rmSync(this.host.recordPath, { force: true });
        this.#set({ state: "error", ...(version ? { version } : {}), message: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.#state;
  }

  cancel(): void {
    // Squirrel owns final staging once verification begins and cannot cancel that operation.
    if (!this.#abort || this.#state.state === "verifying") return;
    this.#abort.abort();
    rmSync(this.host.recordPath, { force: true });
  }

  /** Optional immediate restart follows the same native quit/unsaved-work decisions as File → Quit. */
  async open(): Promise<string> {
    if (this.#state.state !== "done") return "The update is still being prepared.";
    this.#restart.request(() => this.host.quit());
    return "";
  }

  beforeQuit(): void { this.#restart.begin(); }

  finishQuit(exitCode: number): void {
    const job = this.#state;
    if (exitCode !== 0 || job.state !== "done") return;
    this.#set({ state: "installing", version: job.version });
    saveReceipt(this.host.recordPath, { version: job.version, sha256: job.sha256, phase: "applying" });
    this.host.install(job, this.#restart.relaunch);
  }
}
