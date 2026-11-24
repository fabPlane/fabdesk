import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { SpeechBackendId } from "@fabdesk/protocol";
import { SpeechProviderError, type SpeechProvider, type SpeechTranscribeInput } from "./provider";
import { vocabularyPrompt } from "./vocabulary";

export const LOCAL_WHISPER_MODEL = "ggml-tiny.en.bin";
export const DEFAULT_LOCAL_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";

export type LocalSpeechPaths = {
  home: string;
  binDir: string;
  modelPath: string;
  binName: string;
};

export function localSpeechPaths(home: string, platform: NodeJS.Platform = process.platform): LocalSpeechPaths {
  const root = join(home, "runtimes", "whisper");
  const binName = platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  return {
    home,
    binDir: join(root, "bin"),
    modelPath: join(root, "models", LOCAL_WHISPER_MODEL),
    binName,
  };
}

export type LocalRunner = (args: {
  bin: string;
  model: string;
  audio: string;
  language: string;
  prompt: string;
}) => Promise<string>;

export type LocalTranscode = (src: string, mime: string) => Promise<string>;

const WHISPER_NATIVE = /\.(?:wav|flac|mp3|ogg)$/i;

export function whisperCliArgs(args: {
  model: string;
  audio: string;
  language: string;
  prompt: string;
}): string[] {
  const flags = ["-m", args.model, "-f", args.audio, "-nt", "-np", "-l", args.language];
  if (args.prompt) flags.push("--prompt", args.prompt);
  return flags;
}

export function audioExtension(mime: string, filename?: string): string {
  const name = filename?.toLowerCase() ?? "";
  if (name.endsWith(".wav") || mime.includes("wav")) return ".wav";
  if (name.endsWith(".flac") || mime.includes("flac")) return ".flac";
  if (name.endsWith(".mp3") || mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (name.endsWith(".ogg") || mime.includes("ogg")) return ".ogg";
  if (name.endsWith(".m4a") || name.endsWith(".mp4") || mime.includes("mp4") || mime.includes("m4a")) return ".m4a";
  return ".webm";
}

export function createLocalSpeechProvider(opts: {
  home: string;
  which?: (name: string) => string | null;
  exists?: (path: string) => Promise<boolean>;
  run?: LocalRunner;
  transcode?: LocalTranscode;
  platform?: NodeJS.Platform;
}): SpeechProvider {
  const paths = localSpeechPaths(opts.home, opts.platform);
  const exists = opts.exists ?? pathExists;
  const which = opts.which ?? whichOnPath;
  const run = opts.run ?? runWhisperCli;
  const transcode = opts.transcode ?? ffmpegToWav;
  const resolveBin = async (): Promise<string | null> => {
    const envBin = process.env["FABDESK_WHISPER_CLI"]?.trim();
    if (envBin && (await exists(envBin))) return envBin;
    const installed = join(paths.binDir, paths.binName);
    if (await exists(installed)) return installed;
    return which(paths.binName) ?? which("whisper-cli") ?? which("whisper");
  };
  return {
    id: "local" satisfies SpeechBackendId,
    async ready() {
      const bin = await resolveBin();
      const model = await exists(paths.modelPath);
      if (bin && model) return { ready: true };
      if (!bin && !model) {
        return {
          ready: false,
          message: "Local speech is not installed. Download the on-device model in Settings → Voice.",
        };
      }
      if (!bin) {
        return {
          ready: false,
          message: "The local speech model is present, but whisper-cli was not found.",
        };
      }
      return {
        ready: false,
        message: "whisper-cli is present, but the local model has not been downloaded.",
      };
    },
    async transcribe(input: SpeechTranscribeInput) {
      const bin = await resolveBin();
      if (!bin || !(await exists(paths.modelPath))) {
        throw new SpeechProviderError(
          "Local speech is not installed. Download it in Settings → Voice.",
          "unavailable",
        );
      }
      if (input.audio.bytes.byteLength === 0) {
        throw new SpeechProviderError("audio is empty", "invalid_audio");
      }
      const ext = audioExtension(input.audio.mime, input.audio.filename);
      const tmp = join(paths.binDir, `speech-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
      await mkdir(paths.binDir, { recursive: true });
      await writeFile(tmp, input.audio.bytes);
      let wav = tmp;
      try {
        if (!WHISPER_NATIVE.test(tmp) && (opts.transcode || !opts.run)) {
          wav = await transcode(tmp, input.audio.mime);
        }
        const text = (
          await run({
            bin,
            model: paths.modelPath,
            audio: wav,
            language: input.language,
            prompt: vocabularyPrompt(input.hints ?? []),
          })
        ).trim();
        if (!text) throw new SpeechProviderError("Local speech returned an empty transcript.", "provider");
        return { text, backend: "local", language: input.language };
      } finally {
        await unlink(tmp).catch(() => undefined);
        if (wav !== tmp) await unlink(wav).catch(() => undefined);
      }
    },
  };
}

export async function installLocalSpeechModel(opts: {
  home: string;
  download?: (url: string, dest: string) => Promise<void>;
  modelUrl?: string;
}): Promise<{ modelPath: string }> {
  const paths = localSpeechPaths(opts.home);
  await mkdir(join(opts.home, "runtimes", "whisper", "models"), { recursive: true });
  const download = opts.download ?? downloadFile;
  await download(opts.modelUrl ?? DEFAULT_LOCAL_MODEL_URL, paths.modelPath);
  return { modelPath: paths.modelPath };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function whichOnPath(name: string): string | null {
  const path = process.env["PATH"] ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      const file = Bun.file(candidate);
      if (file.size > 0) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function ffmpegToWav(src: string, _mime: string): Promise<string> {
  const dest = `${src.replace(/\.[^.]+$/, "")}.wav`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dest],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (e) => {
      reject(
        new SpeechProviderError(
          e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "Local speech needs ffmpeg on PATH to convert captured audio to WAV."
            : e instanceof Error
              ? e.message
              : String(e),
          "unavailable",
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new SpeechProviderError(err.trim() || `ffmpeg exited ${code}`, "provider"));
        return;
      }
      resolve();
    });
  });
  return dest;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the local speech model (${res.status}).`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function runWhisperCli(args: {
  bin: string;
  model: string;
  audio: string;
  language: string;
  prompt: string;
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args.bin, whisperCliArgs(args), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new SpeechProviderError(err.trim() || `whisper-cli exited ${code}`, "provider"));
        return;
      }
      resolve(out);
    });
  });
}
