import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { rendererMayUseMicrophone } from "./media-permission";
import { validateNativeSpeechRequest, withNativeRecording } from "./native-speech-policy";

const exec = promisify(execFile);
const jobs = new Map<number, { id: string; abort: AbortController }>();
function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "speech", "fabdesk-speech")
    : resolve(app.getAppPath(), "out/native/fabdesk-speech");
}
function trusted(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame || !rendererMayUseMicrophone(event.senderFrame.url)) {
    throw new Error("Speech is available only in the app window.");
  }
}
async function run(args: string[], signal?: AbortSignal, timeout = 100_000): Promise<{ available?: boolean; message?: string; needsDownload?: boolean; text?: string }> {
  let stdout: string;
  try {
    ({ stdout } = await exec(helperPath(), args, {
      timeout, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}),
    }));
  } catch (error) {
    if (signal?.aborted) throw new Error("Speech recognition cancelled.");
    const output = (error as { stdout?: string }).stdout;
    if (output) {
      try { const result = JSON.parse(output) as { error?: string }; if (result.error) throw new Error(result.error); }
      catch (parsed) { if (!(parsed instanceof SyntaxError)) throw parsed; }
    }
    throw new Error("macOS speech recognition could not start. Check Speech Recognition permission in System Settings → Privacy & Security.");
  }
  const result = JSON.parse(stdout) as { available?: boolean; message?: string; needsDownload?: boolean; text?: string; error?: string };
  if (result.error) throw new Error(result.error);
  return result;
}
export function registerNativeSpeech(): void {
  ipcMain.handle("fabdesk:speech-status", async (event, language: unknown) => {
    trusted(event);
    if (process.platform !== "darwin") return { available: false, message: "Native speech is currently available on macOS." };
    try {
      await access(helperPath());
      const result = await run(["status", typeof language === "string" ? language.slice(0, 40) : "en"]);
      return { available: result.available === true, needsDownload: result.needsDownload === true, message: result.message ?? "macOS speech recognition is unavailable." };
    } catch (error) { return { available: false, message: (error as Error).message }; }
  });
  ipcMain.handle("fabdesk:speech-prepare", async (event, language: unknown, id: unknown) => {
    trusted(event);
    if (process.platform !== "darwin" || typeof language !== "string" || !/^[a-zA-Z0-9_-]{2,40}$/.test(language) || typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid on-device setup request.");
    if (jobs.has(event.sender.id)) throw new Error("A speech task is already running.");
    const job = { id, abort: new AbortController() };
    jobs.set(event.sender.id, job);
    const onDestroyed = () => job.abort.abort();
    event.sender.once("destroyed", onDestroyed);
    try {
      const result = await run(["prepare", language], job.abort.signal, 15 * 60_000);
      return { available: result.available === true, needsDownload: result.needsDownload === true, message: result.message ?? "On-device speech setup finished." };
    } finally {
      jobs.delete(event.sender.id);
      if (!event.sender.isDestroyed()) event.sender.removeListener("destroyed", onDestroyed);
    }
  });
  ipcMain.handle("fabdesk:speech-cancel", (event, id: unknown) => {
    trusted(event);
    const job = jobs.get(event.sender.id);
    if (job && job.id === id) job.abort.abort();
  });
  ipcMain.handle("fabdesk:speech-transcribe", async (event, raw: unknown) => {
    trusted(event);
    if (process.platform !== "darwin") throw new Error("Native speech is currently available on macOS.");
    const request = validateNativeSpeechRequest(raw);
    if (jobs.has(event.sender.id)) throw new Error("Speech recognition is already running.");
    const job = { id: request.id, abort: new AbortController() };
    jobs.set(event.sender.id, job);
    const onDestroyed = () => job.abort.abort();
    event.sender.once("destroyed", onDestroyed);
    try {
      const result = await withNativeRecording(request.audio, (audio) => run(["transcribe", request.language, audio], job.abort.signal));
      if (!result.text?.trim()) throw new Error("No speech was detected. Try speaking a little longer.");
      return { text: result.text.trim() };
    } finally {
      jobs.delete(event.sender.id);
      if (!event.sender.isDestroyed()) event.sender.removeListener("destroyed", onDestroyed);
    }
  });
}
