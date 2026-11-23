/**
 * One bridge session per project, with a typed `@fp-pcb/client` connection over the bridge's
 * WebSocket: `KiCad` for the server, `Board` for the open board. The bridge owns the `kicad-cli
 * api-server` process; this only remembers which session belongs to which project directory and
 * reconnects when the bridge reaped it (404 on the next call).
 *
 * The session is opened on `board.kicad_pcb` when the project has one (that opens the board and
 * its project), on `board.kicad_pro` when only the project exists (the board is then opened
 * explicitly), and bare otherwise — the compile job creates the project on a bare session. So
 * `board()` re-asks KiCad for the current board every time rather than caching what may not
 * exist yet.
 */
import { join, sep } from "node:path";
import { assertNativeBoardOwnership } from "./assembly-board-binding";
import { readFile, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { KiCad, type Board, type Schematic } from "@fp-pcb/client";
import { DocumentType } from "@fp-pcb/proto";
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import { currentNativeLayout, withNativeLayout, nativeProjectPath, nativeSessionKey, ToolError, NativeRevisionConflict, jailPath } from "@fabdesk/tools";
export { NativeRevisionConflict } from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";
import {
  captureProjectLibraryRows,
  isManagedLibraryRow,
  rowsToRestore,
  type ProjectLibrarySnapshot,
  type ProjectLibraryRow,
} from "./project-library-tables";

export const BOARD_PRO = "board.kicad_pro";
export const BOARD_PCB = "board.kicad_pcb";

export interface ProjectSession {
  id: string;
  kicad: KiCad;
  ws: WebSocketTransport;
  /** The `.kicad_pro` the session opened, or null for a bare server. */
  path: string | null;
}

export class FpPcbSessions {
  private readonly open = new Map<string, Promise<ProjectSession>>();
  private readonly revisions = new Map<string, Map<string, string | null>>();
  private readonly guarded = new WeakSet<Board | Schematic>();
  private readonly generations = new Map<string, number>();
  private readonly documentGenerations = new Map<string, number>();
  private readonly recovering = new Set<string>();
  private readonly reconciliation = new Map<string, Promise<void>>();
  private readonly libraryRevisions = new WeakMap<ProjectSession, string>();
  private readonly lookupLibraryRevisions = new WeakMap<ProjectSession, string>();
  private readonly libraryWrites = new WeakMap<ProjectSession, Promise<void>>();
  private readonly libraryRegistration = new WeakMap<ProjectSession, Promise<void>>();

  constructor(
    private readonly bridge: () => FpPcbBridgeClient,
    private readonly opts: {
      clientName?: string;
      exists?: (path: string) => Promise<boolean>;
      log?: (m: string) => void;
    } = {},
  ) {}

  /** The session for `projectDir`, creating or reconnecting it as needed. */
  session(projectDir: string): Promise<ProjectSession> {
    if (this.recovering.has(nativeSessionKey(projectDir)))
      return Promise.reject(
        new NativeRevisionConflict("native project recovery is active; retry after it finishes"),
      );
    const cached = this.open.get(nativeSessionKey(projectDir));
    if (cached) return cached;
    const pending = this.connect(projectDir).catch((e) => {
      this.open.delete(nativeSessionKey(projectDir));
      throw e;
    });
    this.open.set(nativeSessionKey(projectDir), pending);
    return pending;
  }

  /** The project's open board; `precondition` when the session has none yet (nothing built). */
  async board(projectDir: string): Promise<Board> {
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const board = await this.withRetry(projectDir, async (s) => {
      const open = await s.kicad.currentBoard();
      if (open) return this.guardSave(projectDir, BOARD_PCB, open);
      // A session started on the .kicad_pro (or bare, then given a project) has the project but no
      // board document open yet.
      const pcb = nativeProjectPath(projectDir, BOARD_PCB);
      if (s.path && (await exists(pcb)))
        return this.guardSave(projectDir, BOARD_PCB, await s.kicad.openBoard(pcb));
      return null;
    });
    if (!board) throw new ToolError("no board is open for this project yet", "precondition");
    return board;
  }

  /** The project's open schematic, without creating project files as a side effect. */
  async schematic(projectDir: string): Promise<Schematic> {
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const schematic = await this.withRetry(projectDir, async (s) => {
      const open = await s.kicad.currentSchematic();
      if (open) return this.guardSave(projectDir, "board.kicad_sch", open);
      const path = nativeProjectPath(projectDir, "board.kicad_sch");
      return (await exists(path))
        ? this.guardSave(projectDir, "board.kicad_sch", await s.kicad.openSchematic(path))
        : null;
    });
    if (!schematic)
      throw new ToolError(
        "board.kicad_sch not found: create it with schematic_edit or circuit_build",
        "precondition",
      );
    return schematic;
  }

  /** Placement recovery may restart KiCad; never discard unsaved schematic work. */
  async assertSchematicSaved(projectDir: string): Promise<void> {
    const session = await this.session(projectDir);
    const schematic = await session.kicad.currentSchematic();
    if (schematic && (await schematic.modified()) !== false)
      throw new NativeRevisionConflict(
        "save the open schematic before placing footprints; placement recovery may restart KiCad",
      );
  }

  /**
   * Ensure the normal `board.kicad_pro/.kicad_sch/.kicad_pcb` triplet exists and is open in one
   * headless KiCad session. This is the native schematic-first entry point; no netlist is needed.
   */
  async ensureProject(
    projectDir: string,
    options: { registerLibraries?: boolean } = {},
  ): Promise<{ session: ProjectSession; schematic: Schematic; board: Board }> {
    return this.withRetry(projectDir, async (s) => {
      const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
      const pro = nativeProjectPath(projectDir, BOARD_PRO);
      const sch = nativeProjectPath(projectDir, "board.kicad_sch");
      const pcb = nativeProjectPath(projectDir, BOARD_PCB);
      if (!(await exists(pro))) {
        await s.kicad.newProject(pro);
        s.path = pro;
        // NewProject owns the stub writes that occur after the initial missing-file check.
        for (const filename of [BOARD_PCB, "board.kicad_sch"])
          this.revisions
            .get(nativeSessionKey(projectDir))
            ?.set(filename, await this.diskRevision(nativeProjectPath(projectDir, filename)));
      }
      // Read-only inspection must not rewrite retained project library tables. Mutation and
      // construction paths can explicitly use bundled libraries through the default behavior.
      if (options.registerLibraries !== false && !currentNativeLayout()) await this.ensureBundledLibraries(projectDir, s);
      let schematic = await s.kicad.currentSchematic();
      if (!schematic) {
        if (await exists(sch)) schematic = await s.kicad.openSchematic(sch);
        else {
          schematic = await s.kicad.newDocument(DocumentType.DOCTYPE_SCHEMATIC, sch);
          this.revisions.get(nativeSessionKey(projectDir))?.set("board.kicad_sch", await this.diskRevision(sch));
        }
      }
      let board = await s.kicad.currentBoard();
      if (!board) {
        if (await exists(pcb)) board = await s.kicad.openBoard(pcb);
        else {
          board = await s.kicad.newDocument(DocumentType.DOCTYPE_PCB, pcb);
          this.revisions.get(nativeSessionKey(projectDir))?.set(BOARD_PCB, await this.diskRevision(pcb));
        }
      }
      return {
        session: s,
        schematic: await this.guardSave(projectDir, "board.kicad_sch", schematic),
        board: await this.guardSave(projectDir, BOARD_PCB, board),
      };
    });
  }

  /** Hundreds of table-row RPCs are setup, not a prerequisite to repeat on every edit. */
  private async ensureBundledLibraries(projectDir: string, session: ProjectSession): Promise<void> {
    const pending = this.libraryRegistration.get(session);
    if (pending) {
      await pending;
      // Recheck after waiting: another writer may have changed the saved tables.
      return this.ensureBundledLibraries(projectDir, session);
    }
    const revision = await this.libraryRevision(projectDir);
    if (this.libraryRevisions.get(session) === revision) return;
    // A second caller may have started setup while the file reads yielded.
    if (this.libraryRegistration.has(session)) return this.ensureBundledLibraries(projectDir, session);
    this.libraryRevisions.delete(session);
    const registration = (async () => {
      await this.preservingProjectLibraries(projectDir, session, () =>
        this.bridge().registerBundledLibraries(session.id),
      );
      this.libraryRevisions.set(session, await this.libraryRevision(projectDir));
    })();
    this.libraryRegistration.set(session, registration);
    try { await registration; }
    finally {
      if (this.libraryRegistration.get(session) === registration) this.libraryRegistration.delete(session);
    }
  }

  /**
   * Run `write`, which may make KiCad save its in-memory project library tables (bundled
   * registration, a compile job), then re-add through the same session every project row the saved
   * tables had before it and lost. KiCad loads the tables once when the project opens, so a row
   * added to `fp-lib-table` afterwards would otherwise vanish on the next table save.
   */
  async preservingProjectLibraries<T>(
    projectDir: string,
    session: ProjectSession,
    write: () => Promise<T>,
    replacing?: { kind: "footprint" | "symbol"; nickname: string },
  ): Promise<T> {
    const previous = this.libraryWrites.get(session) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const queued = previous.then(() => held);
    this.libraryWrites.set(session, queued);
    await previous;
    try { return await this.writePreservingProjectLibraries(projectDir, session, write, replacing); }
    finally {
      unlock();
      if (this.libraryWrites.get(session) === queued) this.libraryWrites.delete(session);
    }
  }

  private async writePreservingProjectLibraries<T>(projectDir: string, session: ProjectSession, write: () => Promise<T>, replacing?: { kind: "footprint" | "symbol"; nickname: string }): Promise<T> {
    const before = await captureProjectLibraryRows(projectDir);
    const recovery = projectDir ? join(projectDir, ".fabdesk", "library-recovery", `${randomUUID()}.json`) : null;
    if (recovery) { await mkdir(join(recovery,".."), { recursive: true }); await writeFile(recovery, JSON.stringify({ before }), { mode: 0o600 }); }
    let expected = JSON.stringify(before);
    const libraries = session.kicad.libraries;
    const originalAdd = libraries?.addTableRow;
    if (originalAdd) libraries.addTableRow = async (...args: Parameters<typeof originalAdd>) => {
      if (JSON.stringify(await captureProjectLibraryRows(projectDir)) !== expected)
        throw new NativeRevisionConflict("Library table changed outside the native writer before a table save; the newer saved version was kept. Reopen before retrying.");
      const result = await originalAdd.apply(libraries, args);
      expected = JSON.stringify(await captureProjectLibraryRows(projectDir));
      return result;
    };
    let result!: T, operationError: unknown, operationFailed = false;
    try { result = await write(); }
    catch (error) { operationError = error; operationFailed = true; }
    finally { if (originalAdd) libraries.addTableRow = originalAdd; }
    if (!operationFailed && replacing && before[replacing.kind])
      before[replacing.kind] = before[replacing.kind]!.filter(row => row.name !== replacing.nickname);
    try {
      try { await this.restoreProjectLibraries(projectDir, session, before); }
      catch (error) {
        if (!isGone(error)) throw error;
        await this.release(projectDir);
        const replacement = await this.session(projectDir);
        await this.restoreProjectLibraries(projectDir, replacement, before);
      }
      if (recovery) await rm(recovery, { force: true });
    } catch (error) {
      if (recovery) await writeFile(recovery, JSON.stringify({ before, after: await captureProjectLibraryRows(projectDir), error: String(error) }), { mode: 0o600 });
      throw new NativeRevisionConflict(`Project library recovery could not finish; saved table versions were preserved${recovery ? ` in ${recovery}` : ""}. Reopen before retrying. ${String(error)}`);
    }
    if (operationFailed) throw operationError;
    return result;
  }

  /** Lookup uses existing project tables without populating them with bundled host paths. */
  async refreshProjectLibraries(projectDir: string): Promise<void> {
    await this.withRetry(projectDir, async session => {
      const previous = this.lookupLibraryRevisions.get(session), current = await this.libraryRevision(projectDir);
      if (previous === current) return;
      const rows = await captureProjectLibraryRows(projectDir);
      const updates: Array<{ kind: "footprint" | "symbol"; row: ProjectLibraryRow }> = [];
      for (const kind of ["footprint", "symbol"] as const) {
        // On the first lookup compare against the table KiCad loaded. Re-adding an identical
        // row saves/reformats the whole table and needlessly invalidates handoff receipts.
        const memory: ProjectLibraryRow[] | null = previous === undefined
          ? (await session.kicad.libraries.tables(kind, "project")).map(entry => ({ name: entry.nickname, uri: entry.uri, type: entry.type || "KiCad", options: entry.options, descr: entry.description, disabled: !entry.enabled, hidden: entry.hidden }))
          : null;
        const changed = previous === undefined ? rowsToRestore(rows[kind], memory) : rows[kind] ?? [];
        for (const row of changed) if (!isManagedLibraryRow(kind, row)) updates.push({ kind, row });
      }
      if (updates.length) await this.preservingProjectLibraries(projectDir, session, async () => {
        for (const { kind, row } of updates) await session.kicad.libraries.addTableRow(kind, "project", { nickname: row.name, uri: row.uri, type: row.type, options: row.options, description: row.descr, enabled: !row.disabled, hidden: row.hidden }, true);
      });
      this.lookupLibraryRevisions.set(session, await this.libraryRevision(projectDir));
    });
  }

  private async restoreProjectLibraries(
    projectDir: string,
    session: ProjectSession,
    before: ProjectLibrarySnapshot,
  ): Promise<string[]> {
    const after = await captureProjectLibraryRows(projectDir);
    const restored: string[] = [];
    for (const kind of ["footprint", "symbol"] as const) {
      for (const row of rowsToRestore(before[kind], after[kind], (row) => isManagedLibraryRow(kind, row))) {
        // A native save and an external editor are independent writers. If disk differs from
        // KiCad's current table, it contains a newer external edit: refuse instead of replaying
        // our older snapshot over it. Recheck before every restorative RPC.
        const native = await session.kicad.libraries.tables(kind, "project");
        const memory: ProjectLibraryRow[] = native.map(entry => ({ name: entry.nickname, uri: entry.uri, type: entry.type || "KiCad", options: entry.options, descr: entry.description, disabled: !entry.enabled, hidden: entry.hidden }));
        const disk = (await captureProjectLibraryRows(projectDir))[kind];
        const identity = (rows: ProjectLibraryRow[] | null) => JSON.stringify(rows?.slice().sort((a, b) => a.name.localeCompare(b.name)).map(r => [r.name, r.type, r.uri, r.options, r.descr, r.disabled, r.hidden]));
        if (identity(disk) !== identity(memory))
          throw new NativeRevisionConflict(`The ${kind} library table was edited outside KiCad during registration; the newer saved table was kept. Reopen the project before retrying.`);
        await session.kicad.libraries.addTableRow(
          kind,
          "project",
          {
            nickname: row.name,
            uri: row.uri,
            type: row.type,
            options: row.options,
            description: row.descr,
            enabled: !row.disabled,
            hidden: row.hidden,
          },
          true,
        );
        restored.push(`${kind}:${row.name}`);
      }
    }
    if (restored.length)
      this.opts.log?.(`restored project library rows KiCad dropped on save: ${restored.join(", ")}`);
    return restored;
  }

  private async libraryRevision(projectDir: string): Promise<string> {
    const revisions: unknown[] = await Promise.all([BOARD_PRO, "sym-lib-table", "fp-lib-table"].map(filename => this.diskRevision(nativeProjectPath(projectDir, filename))));
    const rows = await captureProjectLibraryRows(projectDir);
    for (const kind of ["footprint", "symbol"] as const) for (const row of rows[kind] ?? []) {
      const uri = row.uri.replaceAll("${KIPRJMOD}", projectDir);
      let path: string; try { path = await jailPath(projectDir, uri); } catch { continue; }
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) {
        for (const name of (await readdir(path)).filter(name => name.endsWith(".kicad_mod")).sort()) {
          const file = await jailPath(projectDir, join(path,name)); revisions.push([kind,row.name,name,await this.diskRevision(file)]);
        }
      } else revisions.push([kind,row.name,await this.diskRevision(path)]);
    }
    return JSON.stringify(revisions);
  }

  /** Runs `fn` on the session, reconnecting once when the bridge no longer knows it. */
  async withRetry<T>(projectDir: string, fn: (s: ProjectSession) => Promise<T>): Promise<T> {
    const s = await this.session(projectDir);
    try {
      await this.reconcile(projectDir, s);
      return await fn(s);
    } catch (e) {
      if (!isGone(e)) throw e;
      this.opts.log?.(
        `fp-pcb session for ${projectDir} is gone (${e instanceof Error ? e.message : String(e)}); reconnecting`,
      );
      await this.release(projectDir);
      const replacement = await this.session(projectDir);
      await this.reconcile(projectDir, replacement);
      return fn(replacement);
    }
  }

  /**
   * Drop the project's session and stop its KiCad process on the bridge. The bridge never reaps a
   * session on its own, so without this every built-then-deleted project (and every daemon restart
   * that could not re-adopt) left a ~500 MB kicad-cli behind.
   */
  async release(projectDir: string): Promise<void> {
    const key = nativeSessionKey(projectDir);
    const keys = currentNativeLayout() ? [key] : [...new Set([key, ...[...this.open.keys()].filter(path => path.startsWith(projectDir + sep))])];
    for (const source of keys) await this.releaseKey(source);
  }

  private async releaseKey(key: string): Promise<void> {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const pending = this.open.get(key);
    this.open.delete(key);
    this.revisions.delete(key);
    if (!pending) return;
    const session = await pending.catch(() => null);
    if (!session) return;
    await session.ws.close().catch(() => undefined);
    await this.bridge().deleteSession(session.id).catch(() => undefined);
  }

  /** Close this source's API server so the next operation reloads its saved native files. */
  async restart(projectDir: string): Promise<void> {
    await this.releaseKey(nativeSessionKey(projectDir));
  }

  async dispose(): Promise<void> {
    for (const key of [...this.open.keys()]) await this.releaseKey(key);
  }

  /** Suspend session access while saved files are replaced. Never discard unsaved live work. */
  async withSavedFilesRecovery<T>(projectDir: string, replace: () => Promise<T>): Promise<T> {
    if (this.recovering.has(nativeSessionKey(projectDir)))
      throw new NativeRevisionConflict("native project recovery is already active");
    this.recovering.add(nativeSessionKey(projectDir));
    try {
      // Also inspect an adopted bridge session after a core restart; absence from our map
      // does not prove there is no live work.
      let pending = this.open.get(nativeSessionKey(projectDir));
      if (!pending) {
        pending = this.connect(projectDir).catch((error) => {
          this.open.delete(nativeSessionKey(projectDir));
          throw error;
        });
        this.open.set(nativeSessionKey(projectDir), pending);
      }
      const session = await pending;
      if (session) {
        const documents = [
          await session.kicad.currentBoard(),
          await session.kicad.currentSchematic(),
        ];
        for (const document of documents)
          if (document && (await document.modified()) !== false)
            throw new NativeRevisionConflict(
              "checkpoint restore refused: live document has unsaved or unknown changes; save or preserve that work before restoring",
            );
        // A failed termination must not proceed to replacing saved files.
        await this.bridge().deleteSession(session.id);
        await session.ws.close().catch(() => undefined);
        this.open.delete(nativeSessionKey(projectDir));
      }
      this.revisions.delete(nativeSessionKey(projectDir));
      this.generations.set(nativeSessionKey(projectDir), (this.generations.get(nativeSessionKey(projectDir)) ?? 0) + 1);
      return await replace();
    } finally {
      this.recovering.delete(nativeSessionKey(projectDir));
    }
  }

  private async diskRevision(path: string): Promise<string | null> {
    try {
      return createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Reconcile saved documents only; never discard unsaved or unknown live state. */
  private async reconcile(projectDir: string, session: ProjectSession): Promise<void> {
    const previous = this.reconciliation.get(nativeSessionKey(projectDir)) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => this.reconcileSaved(projectDir, session));
    this.reconciliation.set(nativeSessionKey(projectDir), pending);
    try {
      await pending;
    } finally {
      if (this.reconciliation.get(nativeSessionKey(projectDir)) === pending) this.reconciliation.delete(nativeSessionKey(projectDir));
    }
  }

  private async reconcileSaved(projectDir: string, session: ProjectSession): Promise<void> {
    if (!projectDir) return;
    let known = this.revisions.get(nativeSessionKey(projectDir));
    if (!known) {
      known = new Map();
      this.revisions.set(nativeSessionKey(projectDir), known);
    }
    const pending: Array<{
      filename: string;
      path: string;
      disk: string | null;
      document: Board | Schematic | undefined;
    }> = [];
    // Preflight the entire pair before closing either document.
    for (const filename of [BOARD_PCB, "board.kicad_sch"]) {
      const path = nativeProjectPath(projectDir, filename);
      const disk = await this.diskRevision(path);
      // A document not seen before has unknown loaded provenance (including adopted sessions).
      // Reopen it from disk once rather than declaring its current bytes to be the loaded bytes.
      if (known.has(filename) && known.get(filename) === disk) continue;
      const document =
        filename === BOARD_PCB
          ? await session.kicad.currentBoard()
          : await session.kicad.currentSchematic();
      if (document) {
        if ((await document.modified()) !== false)
          throw new NativeRevisionConflict(
            `${filename} disk/session conflict: saved revision ${disk ?? "missing"}, loaded revision ${known.get(filename) ?? "unknown"}; live document has unsaved or unknown changes. Preserve both versions and explicitly resolve them before continuing.`,
          );
        if (disk === null)
          throw new NativeRevisionConflict(
            `${filename} was removed on disk; refusing to overwrite it from the loaded session`,
          );
        // Verify once more after querying live state; fail closed on a moving target.
        if ((await this.diskRevision(path)) !== disk)
          throw new NativeRevisionConflict(
            `${filename} changed during reconciliation; retry after the external writer finishes`,
          );
      }
      pending.push({ filename, path, disk, document });
    }
    for (const { filename, path, disk, document } of pending) {
      if ((await this.diskRevision(path)) !== disk)
        throw new NativeRevisionConflict(
          `${filename} changed before reconciliation; retry after the external writer finishes`,
        );
      if (document) {
        if ((await document.modified()) !== false)
          throw new NativeRevisionConflict(
            `${filename} became modified during reconciliation; preserve live work before continuing`,
          );
        this.documentGenerations.set(path, (this.documentGenerations.get(path) ?? 0) + 1);
        await document.close();
        if (filename === BOARD_PCB) await session.kicad.openBoard(path);
        else await session.kicad.openSchematic(path);
        if ((await this.diskRevision(path)) !== disk)
          throw new NativeRevisionConflict(
            `${filename} changed while reopening; retry after the external writer finishes`,
          );
        this.opts.log?.(`fp-pcb: reloaded ${filename} from saved revision ${disk}`);
      }
      known.set(filename, disk);
    }
  }

  /**
   * Record a save the bridge made of the live document (the route job refills and saves before
   * exporting its DSN) as the loaded revision. That save bypasses `guardSave`, so without this the
   * next acquisition sees changed disk bytes plus the job's unsaved applied copper and refuses.
   * Only call it while the caller holds the operation that owned the save.
   */
  async adoptSaved(projectDir: string, filename: string): Promise<void> {
    this.revisions
      .get(nativeSessionKey(projectDir))
      ?.set(filename, await this.diskRevision(nativeProjectPath(projectDir, filename)));
  }

  /** A document acquired before an external restore must never save over that restore. */
  private async guardSave<T extends Board | Schematic>(
    projectDir: string,
    filename: string,
    document: T,
  ): Promise<T> {
    if (this.guarded.has(document)) return document;
    const layout = currentNativeLayout(), sourceKey = nativeSessionKey(projectDir);
    const path = nativeProjectPath(projectDir, filename);
    const generation = this.generations.get(sourceKey) ?? 0;
    const documentGeneration = this.documentGenerations.get(path) ?? 0;
    // Bind to the state reconciled/created by the owner, not newly sampled bytes that may
    // have changed between reconciliation and acquiring the document wrapper.
    let expected = this.revisions.get(sourceKey)?.get(filename);
    if (expected === undefined || (await this.diskRevision(path)) !== expected)
      throw new NativeRevisionConflict(
        `${filename} changed while acquiring the native document; refusing access to potentially stale state. Retry after the external writer finishes.`,
      );
    const save = document.save.bind(document);
    const saveOwned = async () => {
      await assertNativeBoardOwnership(projectDir);
      if (
        this.recovering.has(sourceKey) ||
        generation !== (this.generations.get(sourceKey) ?? 0) ||
        documentGeneration !== (this.documentGenerations.get(path) ?? 0)
      )
        throw new NativeRevisionConflict(
          `${filename} document handle predates recovery/reload; refusing stale save. Reacquire the current document.`,
        );
      const disk = await this.diskRevision(path);
      if (disk !== expected)
        throw new NativeRevisionConflict(
          `${filename} changed on disk since this document was acquired (expected ${expected ?? "missing"}, found ${disk ?? "missing"}); refusing stale save. Live edits and saved file are preserved.`,
        );
      await save();
      expected = await this.diskRevision(path);
      this.revisions.get(sourceKey)?.set(filename, expected);
    };
    document.save = () => layout ? withNativeLayout(layout, saveOwned) : saveOwned();
    this.guarded.add(document);
    return document;
  }

  private async connect(projectDir: string): Promise<ProjectSession> {
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const pro = nativeProjectPath(projectDir, BOARD_PRO);
    const pcb = nativeProjectPath(projectDir, BOARD_PCB);
    const path = (await exists(pcb)) ? pcb : (await exists(pro)) ? pro : null;
    const bridge = this.bridge();
    const clientName = this.opts.clientName ?? `fabdesk/core/${process.pid}`;
    const attach = async (id: string): Promise<{ kicad: KiCad; ws: WebSocketTransport }> => {
      const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, id));
      try {
        return { kicad: await KiCad.connect(ws, { clientName }), ws };
      } catch (e) {
        await ws.close().catch(() => undefined);
        throw e;
      }
    };
    // A session the bridge lists under this project's path.
    const sessions = await bridge.sessions();
    const live = (s: { state: string }) => !["failed", "stopped", "exited"].includes(s.state);
    const byPath = path
      ? sessions.find((s) => (s.path === pcb || s.path === pro) && live(s))
      : undefined;
    if (byPath) return { id: byPath.id, ...(await attach(byPath.id)), path };
    // A bare session whose open project is this one: the compile job created the project inside a
    // session the bridge started without a path, and the bridge still lists it as bare.
    if (path) {
      for (const s of sessions.filter((x) => x.path === null && live(x))) {
        const a = await attach(s.id).catch(() => null);
        if (!a) continue;
        const open = await a.kicad
          .projectInfo()
          .then((i) => i.kicadProPath)
          .catch(() => "");
        if (open === pro) {
          this.opts.log?.(`fp-pcb: adopting bare session ${s.id} that holds ${path}`);
          return { id: s.id, ...a, path };
        }
        await a.ws.close().catch(() => undefined);
      }
    }
    const initial = new Map<string, string | null>();
    for (const filename of [BOARD_PCB, "board.kicad_sch"])
      initial.set(filename, await this.diskRevision(nativeProjectPath(projectDir, filename)));
    const session = await bridge.createSession(path);
    const connection = await attach(session.id);
    for (const [filename, revision] of initial) {
      if ((await this.diskRevision(nativeProjectPath(projectDir, filename))) !== revision) {
        await connection.ws.close().catch(() => undefined);
        await bridge.deleteSession(session.id).catch(() => undefined);
        throw new NativeRevisionConflict(
          `${filename} changed while starting the native session; retry after the external writer finishes`,
        );
      }
    }
    // Only a session we just launched has known provenance. Adopted sessions still reconcile.
    this.revisions.set(nativeSessionKey(projectDir), initial);
    return { id: session.id, ...connection, path };
  }
}

function isGone(e: unknown): boolean {
  if (e instanceof ToolError) return e.code === "not_found";
  const message = e instanceof Error ? e.message : String(e);
  return /closed|not connected|ECONNRESET|unknown session|server restarted|kicad_token/i.test(
    message,
  );
}
