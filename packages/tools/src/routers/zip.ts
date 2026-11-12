/** Zip extraction with the tools a desktop machine has: unzip, then (Windows) bsdtar and PowerShell. */
export async function extractZipArchive(
  archive: string,
  dest: string,
  spawn: (cmd: string, args: string[]) => Promise<number>,
  platform: string = process.platform,
): Promise<void> {
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "unzip", args: ["-o", archive, "-d", dest] },
  ];
  if (platform === "win32" || platform === "windows") {
    // Windows 10+ ships bsdtar, which extracts zip. PowerShell is the fallback
    // when neither unzip nor tar is on PATH (typical Electron desktop).
    attempts.push({ cmd: "tar", args: ["-xf", archive, "-C", dest] });
    attempts.push({
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Force -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}'`,
      ],
    });
  }
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const code = await spawn(attempt.cmd, attempt.args);
      if (code === 0) return;
      errors.push(`${attempt.cmd} exited ${code}`);
    } catch (error) {
      errors.push(`${attempt.cmd}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`failed to extract zip artifact (${errors.join("; ")})`);
}
