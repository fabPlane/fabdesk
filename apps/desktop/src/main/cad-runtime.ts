/** Consent-gated optional CAD. Trusted version/URLs are main-process policy, never renderer input. */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import type { CadRuntimeOffer, CadRuntimeState } from "@fabdesk/protocol";
export const CAD_RELEASE = "cad-runtime-v1-9bcf850-65c72d6";
export const CAD_REPOSITORY = "fabPlane/FreeCAD";
export const CAD_FREECAD_COMMIT = "9bcf850de03c79e12c1e8bedd550ae2265b624f0";
export const CAD_BRIDGE_COMMIT = "65c72d69e59c503ad1d23790448a954d5fc283b7";
export const CAD_TEAM = "CMNZZ92926";
const BASE = `https://github.com/${CAD_REPOSITORY}/releases/download/${CAD_RELEASE}/`;
export interface CadRuntimeManifest extends CadRuntimeOffer {
  format: 1;
  sha256: string;
  url: string;
  freecadCommit: string;
  fabCadCommit: string;
  licensesUrl: string;
  sourcesUrl: string;
  sourcesSha256: string;
  licensesSha256: string;
}
export function validateCadManifest(raw: unknown): CadRuntimeManifest {
  const m = raw as CadRuntimeManifest;
  if (
    !m ||
    m.format !== 1 ||
    m.version !== CAD_RELEASE ||
    m.target !== "darwin-arm64" ||
    m.minimumOS !== "15.0" ||
    m.freecadCommit !== CAD_FREECAD_COMMIT ||
    m.fabCadCommit !== CAD_BRIDGE_COMMIT ||
    m.url !== BASE + "cad-runtime-darwin-arm64.zip" ||
    m.sourcesUrl !== BASE + "cad-runtime-sources.tar.gz" ||
    m.licensesUrl !== BASE + "NOTICE.txt" ||
    m.sourceUrl !== `https://github.com/${CAD_REPOSITORY}/releases/tag/${CAD_RELEASE}` ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !/^[a-f0-9]{64}$/.test(m.sourcesSha256) ||
    !/^[a-f0-9]{64}$/.test(m.licensesSha256) ||
    !Number.isSafeInteger(m.downloadBytes) ||
    m.downloadBytes < 1 ||
    m.downloadBytes > 2_000_000_000 ||
    !Number.isSafeInteger(m.installedBytes) ||
    m.installedBytes < m.downloadBytes ||
    m.installedBytes > 3_000_000_000
  )
    throw new Error("Invalid or incompatible CAD runtime manifest");
  return m;
}
interface Dependencies {
  cache: string;
  target: string;
  supportedOS: boolean;
  fetch?: typeof fetch;
  installedApps?: string[];
  freeBytes?: () => Promise<number>;
  verify(app: string): Promise<string>;
  unpack(archive: string, directory: string, bytes: number): Promise<void>;
  activate(manifest: string): Promise<void>;
  changed?(state: CadRuntimeState): void;
}
export class CadRuntimeManager {
  private current: CadRuntimeState = { status: "missing" };
  private offer: CadRuntimeManifest | null = null;
  private operation: Promise<CadRuntimeState> | null = null;
  private abort: AbortController | null = null;
  private initialized = false;
  private deferred = false;
  constructor(private readonly deps: Dependencies) {}
  state(): CadRuntimeState {
    return this.current;
  }
  private set(s: CadRuntimeState): CadRuntimeState {
    this.current = s;
    this.deps.changed?.(s);
    return s;
  }
  private get installed(): string {
    return join(this.deps.cache, CAD_RELEASE, "CADRuntime.app");
  }
  async initialize(): Promise<CadRuntimeState> {
    if (this.initialized) return this.current;
    await mkdir(this.deps.cache, { recursive: true, mode: 0o700 });
    // Never remove another live process's partial download.
    const lock = join(this.deps.cache, "install.lock");
    try {
      const pid = Number(await readFile(lock, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error("CAD installation is active in another window");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
      await rm(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        return this.set({ status: "error", message: String(e) });
    }
    for (const name of await readdir(this.deps.cache))
      if (name.startsWith(".install-"))
        await rm(join(this.deps.cache, name), { recursive: true, force: true });
    this.initialized = true;
    this.deferred = await readFile(join(this.deps.cache, "deferred"), "utf8").then(
      () => true,
      () => false,
    );
    if (this.deps.target !== "darwin-arm64" || !this.deps.supportedOS)
      return this.set({
        status: "unsupported",
        message:
          "This CAD runtime supports Apple Silicon Macs (ARM64) on macOS 15 or later. Intel Macs, Windows and Linux are not supported yet. PCB remains available.",
      });
    try {
      await stat(this.installed);
      await this.deps.activate(await this.deps.verify(this.installed));
      return this.set({ status: "ready" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        return this.set({
          status: "error",
          message: `Installed CAD engine is incompatible or could not start: ${String(e)}`,
        });
    }
    for (const candidate of this.deps.installedApps ?? []) {
      try {
        await stat(candidate);
        await this.deps.activate(await this.deps.verify(candidate));
        return this.set({ status: "ready" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          return this.set({
            status: "error",
            message: `Installed CAD engine is incompatible: ${String(e)}`,
          });
      }
    }
    return this.set({ status: this.deferred ? "deferred" : "missing" });
  }
  /** Metadata only, on explicit CAD use. Never fetch an engine here. */
  prepare(): Promise<CadRuntimeState> {
    if (this.operation) return this.operation;
    const task = this.prepareInner();
    this.operation = task;
    void task
      .finally(() => {
        if (this.operation === task) this.operation = null;
      })
      .catch(() => {});
    return task;
  }
  private async prepareInner(): Promise<CadRuntimeState> {
    await this.initialize();
    if (this.offer || ["ready", "unsupported"].includes(this.current.status)) return this.current;
    try {
      const response = await (this.deps.fetch ?? fetch)(BASE + "manifest-darwin-arm64.json", {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "The signed CAD runtime has not been published yet."
            : `CAD metadata download failed (${response.status}).`,
        );
      if (!response.body) throw new Error("Empty CAD metadata");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > 16384) throw new Error("CAD metadata too large");
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      this.offer = validateCadManifest(JSON.parse(text));
      return this.set({ status: this.deferred ? "deferred" : "consent", offer: this.offer });
    } catch (e) {
      return this.set({
        status: "error",
        message: `${e instanceof Error ? e.message : String(e)} PCB remains available. Retry when online.`,
      });
    }
  }
  async defer(): Promise<CadRuntimeState> {
    this.cancel();
    this.deferred = true;
    await mkdir(this.deps.cache, { recursive: true });
    await writeFile(join(this.deps.cache, "deferred"), "later\n", { mode: 0o600 });
    return this.set({ status: "deferred", ...(this.offer ? { offer: this.offer } : {}) });
  }
  cancel(): void {
    this.abort?.abort();
  }
  /** Only the explicit Download button invokes this; first-use preparation never does. */
  download(): Promise<CadRuntimeState> {
    if (this.operation) return this.operation;
    if (!this.offer || this.current.status === "ready" || this.current.status === "unsupported")
      return Promise.resolve(this.current);
    const task = this.install(this.offer);
    this.operation = task;
    void task
      .finally(() => {
        if (this.operation === task) this.operation = null;
      })
      .catch(() => {});
    return task;
  }
  private async install(m: CadRuntimeManifest): Promise<CadRuntimeState> {
    const abort = new AbortController();
    this.abort = abort;
    const work = join(this.deps.cache, `.install-${process.pid}`),
      lockPath = join(this.deps.cache, "install.lock");
    let locked = false;
    try {
      const lock = await open(lockPath, "wx", 0o600);
      locked = true;
      await lock.writeFile(String(process.pid));
      await lock.close();
      const disk = this.deps.freeBytes
        ? await this.deps.freeBytes()
        : await statfs(this.deps.cache).then((s) => s.bavail * s.bsize);
      if (disk < m.downloadBytes + m.installedBytes + 128 * 1024 * 1024)
        throw new Error(
          "Not enough free space for the CAD runtime download and atomic installation",
        );
      await mkdir(work, { recursive: true });
      const zip = join(work, "runtime.zip.part");
      this.set({ status: "downloading", offer: m, received: 0 });
      const response = await (this.deps.fetch ?? fetch)(m.url, { signal: abort.signal });
      if (!response.ok || !response.body)
        throw new Error(`CAD download failed (${response.status})`);
      const hash = createHash("sha256"),
        file = await open(zip, "wx", 0o600);
      let received = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          abort.signal.throwIfAborted();
          received += chunk.length;
          if (received > m.downloadBytes) throw new Error("CAD download exceeds advertised size");
          hash.update(chunk);
          await file.writeFile(chunk);
          this.set({ status: "downloading", offer: m, received });
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (received !== m.downloadBytes || hash.digest("hex") !== m.sha256)
        throw new Error("CAD runtime checksum or size mismatch");
      abort.signal.throwIfAborted();
      this.set({ status: "verifying", offer: m });
      const extracted = join(work, "extracted");
      await mkdir(extracted);
      await this.deps.unpack(zip, extracted, m.installedBytes);
      abort.signal.throwIfAborted();
      await this.deps.verify(join(extracted, "CADRuntime.app"));
      abort.signal.throwIfAborted();
      // Verified contents are exposed atomically; previous good installs survive every failure.
      const final = join(this.deps.cache, CAD_RELEASE);
      let previous: string | null = null;
      try {
        await stat(final);
        try {
          await this.deps.activate(await this.deps.verify(this.installed));
          return this.set({ status: "ready", offer: m });
        } catch {
          previous = join(this.deps.cache, `.rejected-${Date.now()}`);
          await rename(final, previous);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        await rename(extracted, final);
      } catch (e) {
        if (previous) await rename(previous, final);
        throw e;
      }
      await this.deps.activate(await this.deps.verify(this.installed));
      this.deferred = false;
      await rm(join(this.deps.cache, "deferred"), { force: true });
      return this.set({ status: "ready", offer: m });
    } catch (e) {
      return this.set(
        abort.signal.aborted
          ? { status: "deferred", offer: m }
          : { status: "error", offer: m, message: e instanceof Error ? e.message : String(e) },
      );
    } finally {
      await rm(work, { recursive: true, force: true });
      if (locked) await rm(lockPath, { force: true });
      this.abort = null;
    }
  }
}

/** One native consent dialog across concurrent renderer requests; decline persists. */
export class CadRuntimeConsent {
  private pending: Promise<CadRuntimeState> | null = null;
  constructor(
    private readonly manager: CadRuntimeManager,
    private readonly confirm: (offer: CadRuntimeOffer) => Promise<boolean>,
  ) {}
  request(): Promise<CadRuntimeState> {
    if (this.pending) return this.pending;
    const state = this.manager.state();
    if (!state.offer || ["ready", "unsupported", "downloading", "verifying"].includes(state.status))
      return Promise.resolve(state);
    const task = this.confirm(state.offer).then((allowed) =>
      allowed ? this.manager.download() : this.manager.defer(),
    );
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = null;
      })
      .catch(() => {});
    return task;
  }
}
