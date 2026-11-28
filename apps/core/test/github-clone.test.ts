import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneGitHubRepository } from "../src/github-clone";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function target(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "github-clone-"));
  roots.push(root);
  const dir = join(root, "project");
  await mkdir(dir);
  return dir;
}

const AUTH = { GIT_CONFIG_VALUE_0: "Authorization: Basic fixture" };
const REFUSED = "remote: Repository not found.\nfatal: repository 'https://github.com/o/private.git/' not found";
type Call = { env: NodeJS.ProcessEnv | undefined; full: boolean | undefined; leftovers: string[] };

test("a public repository clones anonymously and the GitHub connection is never asked for", async () => {
  const dir = await target(), calls: Call[] = [];
  let asked = 0;
  const result = await cloneGitHubRepository({ url: "https://github.com/o/public.git", dir, authEnv: async () => { asked++; return AUTH; },
    clone: async (_url, _dir, _signal, options) => { calls.push({ env: options?.env, full: options?.full, leftovers: [] }); } });
  expect(result).toEqual({ authenticated: false });
  expect(calls).toEqual([{ env: undefined, full: undefined, leftovers: [] }]);
  expect(asked).toBe(0);
});

test("a refused clone is retried once with the connection, in a clean folder, fetching every file", async () => {
  const dir = await target(), calls: Call[] = [];
  const result = await cloneGitHubRepository({ url: "https://github.com/o/private.git", dir, authEnv: async () => AUTH,
    clone: async (_url, into, _signal, options) => {
      calls.push({ env: options?.env, full: options?.full, leftovers: await readdir(into) });
      if (!options?.env) { await writeFile(join(into, "partial"), "x"); throw new Error(REFUSED); }
    } });
  expect(result).toEqual({ authenticated: true });
  expect(calls).toEqual([{ env: undefined, full: undefined, leftovers: [] }, { env: AUTH, full: true, leftovers: [] }]);
});

test("without a connection a refused clone says how to import a private repository", async () => {
  const dir = await target();
  let attempts = 0;
  await expect(cloneGitHubRepository({ url: "https://github.com/o/private.git", dir, authEnv: async () => null,
    clone: async () => { attempts++; throw new Error(REFUSED); } })).rejects.toThrow("connect GitHub under Home › Work");
  expect(attempts).toBe(1);
});

test("the connection is not used for failures that are not about access, or after a cancel", async () => {
  const dir = await target();
  let asked = 0;
  const authEnv = async () => { asked++; return AUTH; };
  await expect(cloneGitHubRepository({ url: "https://github.com/o/r.git", dir, authEnv, clone: async () => { throw new Error("fatal: unable to access: Could not resolve host: github.com"); } })).rejects.toThrow("Could not resolve host");
  const missing = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", syscall: "spawn git", path: "git" });
  await expect(cloneGitHubRepository({ url: "https://github.com/o/r.git", dir, authEnv, clone: async () => { throw missing; } })).rejects.toBe(missing);
  const controller = new AbortController();
  controller.abort();
  await expect(cloneGitHubRepository({ url: "https://github.com/o/r.git", dir, signal: controller.signal, authEnv, clone: async () => { throw new Error(REFUSED); } })).rejects.toThrow("not found");
  expect(asked).toBe(0);
});

test("a repository the connected account cannot read is reported as that, not as a raw git error", async () => {
  const dir = await target();
  await expect(cloneGitHubRepository({ url: "https://github.com/o/private.git", dir, authEnv: async () => AUTH,
    clone: async () => { throw new Error(REFUSED); } })).rejects.toThrow("Your GitHub connection cannot read this repository");
});
