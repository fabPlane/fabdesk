import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

export const Credentials = z.object({
  version: z.literal(1),
  apiOrigin: z.string().min(1),
  token: z.string().min(1),
  subject: z.string(),
  handle: z.string().optional(),
  displayName: z.string().optional(),
  obtainedAt: z.string(),
  expiresAt: z.string(),
});
export type Credentials = z.infer<typeof Credentials>;

export const CREDENTIALS_FILE = "credentials.json";

export function credentialsPath(home: string): string {
  return join(home, CREDENTIALS_FILE);
}

/** Returns the stored credentials, or `undefined` when the file is missing or malformed. */
export async function readCredentials(home: string): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(home), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = Credentials.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Writes atomically (temp file + rename) with mode 0600 inside a 0700 directory. */
export async function writeCredentials(home: string, creds: Credentials): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const target = credentialsPath(home);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const data = `${JSON.stringify(creds, null, 2)}\n`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(tmp, 0o600); // umask-proof
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function deleteCredentials(home: string): Promise<void> {
  await rm(credentialsPath(home), { force: true });
}
