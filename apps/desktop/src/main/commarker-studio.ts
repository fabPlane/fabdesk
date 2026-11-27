import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

interface StudioHost {
  platform: NodeJS.Platform;
  temp: string;
  userData: string;
  candidates: string[];
  pickStudio: () => Promise<string | undefined>;
  openApplication: (path: string) => Promise<string>;
  copyPath: (path: string) => boolean | Promise<boolean>;
  reveal: (path: string) => void;
}

export function studioCandidates(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    return ["/Applications", join(home, "Applications")].flatMap(root =>
      ["ComMarker_Studio.app", "ComMarker Studio.app"].map(name => join(root, name)));
  }
  if (platform !== "win32") return [];
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
  return roots.flatMap(root => root ? ["ComMarker_Studio", "ComMarker Studio"].map(folder =>
    join(root, folder, "ComMarker_Studio.exe")) : []);
}

async function isStudio(path: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const suffix = platform === "darwin" ? "app" : "exe";
  if (!new RegExp(`^commarker[ _]?studio\\.${suffix}$`, "i").test(basename(path))) return false;
  const entry = await stat(path).catch(() => null);
  return platform === "darwin" ? entry?.isDirectory() === true : entry?.isFile() === true;
}

async function launchStudio(path: string, host: StudioHost): Promise<boolean> {
  if (!await isStudio(path, host.platform)) return false;
  try {
    return (await host.openApplication(path)) === "";
  } catch {
    return false;
  }
}

function validateFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== "string" || !/\.(svg|orzr)$/i.test(filename) || filename.startsWith(".")
    || /[<>:"/\\|?*\x00-\x1f]/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename)) {
    throw new Error("Choose a plain SVG or Studio project filename.");
  }
}

export async function prepareComMarkerStudio(filename: unknown, file: unknown, host: StudioHost) {
  if (host.platform !== "win32" && host.platform !== "darwin") throw new Error("ComMarker Studio requires Windows or macOS.");
  validateFilename(filename);
  if (!(file instanceof Uint8Array) || !file.byteLength) throw new Error("The Studio file is empty or unavailable.");

  // Each import gets an independent file, including when the daemon is on another machine.
  const folder = await mkdtemp(join(host.temp, "fabdesk-copper-"));
  const path = join(folder, filename);
  await writeFile(path, file, { flag: "wx" });

  const preference = join(host.userData, "commarker-studio-path.txt");
  const saved = await readFile(preference, "utf8").catch(() => "");
  let opened = false;
  for (const application of new Set([saved, ...host.candidates])) {
    if (await launchStudio(application, host)) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    const selected = await host.pickStudio();
    if (selected && await launchStudio(selected, host)) {
      opened = true;
      // Remember portable installations. A settings write failure doesn't invalidate the handoff.
      await mkdir(host.userData, { recursive: true }).then(() => writeFile(preference, selected)).catch(() => {});
    }
  }
  const copied = await host.copyPath(path);
  if (!opened) host.reveal(path);
  return { path, opened, copied };
}
