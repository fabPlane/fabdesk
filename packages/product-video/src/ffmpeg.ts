import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
  join(homedir(), ".fabdesk", "runtimes", "ffmpeg", "ffmpeg"),
];

/** Locate an ffmpeg binary: explicit path, $FABDESK_FFMPEG, PATH, then common install locations. */
export async function findFfmpeg(explicit?: string | null): Promise<string | null> {
  if (explicit) return (await probe(explicit)) ? explicit : null;
  const listed = [process.env.FABDESK_FFMPEG, Bun.which("ffmpeg"), ...CANDIDATES].filter(
    (p): p is string => Boolean(p),
  );
  const seen = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (await probe(path)) return path;
  }
  return null;
}

async function probe(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([path, "-version"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) return false;
    const out = `${await new Response(proc.stdout).text()} ${await new Response(proc.stderr).text()}`;
    return /ffmpeg/i.test(out);
  } catch {
    return false;
  }
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn([ffmpeg, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (signal) signal.removeEventListener("abort", onAbort);
  return { ok: code === 0, stderr };
}

export function mp4Args(pattern: string, fps: number, output: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(fps), "-i", pattern, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", output];
}

export function webmArgs(pattern: string, fps: number, output: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(fps), "-i", pattern, "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", "32", "-b:v", "0", output];
}
