/**
 * `CadService` over a FabPlane CAD bridge: one bridge session (one `FreeCADApiServer`) per
 * project, reached with `@fab-cad/client` over the bridge's `/ws`. The project's model is
 * `model.FCStd`; the session opens it at start when it exists, otherwise the first call creates the
 * document and saves it there.
 *
 * Every tab of the fab_cad web UI that attaches to the same session (`view()`) gets its own
 * upstream connection, so edits made by the agent show up there live through FreeCAD's events,
 * and edits made in the UI are in the document the next tool call reads.
 *
 * A session the bridge lost (reaped, crashed, or a restarted FreeCAD whose token no longer
 * matches) is reconnected once per call, the way `FpPcbSessions.withRetry` does it.
 */
import { join } from "node:path";
import {
  FreeCADApiError,
  FreeCADClient,
  TransportError,
  WebSocketTransport,
  type DocumentInfo,
  type ObjectInfo,
  type PropertyInfo,
  type PropertyInput,
  type WireValue,
} from "@fab-cad/client";
import { PROJECT_FILES, ToolError } from "@fabdesk/tools";
import type { CadObject, CadProperty, CadService, CadStatus, CadView } from "@fabdesk/tools";
import type { FabCadBridgeClient } from "./fab-cad-bridge";

/** Workbench modules the tools and the web UI expect; a server without one still works. */
const MODULES = ["Part", "Sketcher", "PartDesign"] as const;

interface Connection {
  session: string;
  client: FreeCADClient;
  /** FreeCAD's internal name of the project's document. */
  doc: string;
  path: string;
}

export function createFabCad(deps: {
  bridge: () => FabCadBridgeClient;
  exists?: (path: string) => Promise<boolean>;
  clientName?: string;
  log?: (m: string) => void;
}): CadService & { dispose(): Promise<void> } {
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  const clientName = deps.clientName ?? `fabdesk/core/${process.pid}`;
  const open = new Map<string, Promise<Connection>>();

  async function attach(session: string): Promise<FreeCADClient> {
    const transport = await WebSocketTransport.connect(deps.bridge().wsUrl(session), {
      connectTimeoutMs: 10_000,
    });
    try {
      const client = await FreeCADClient.connect(transport, { clientName });
      for (const m of MODULES) await client.loadModule(m).catch(() => undefined);
      return client;
    } catch (e) {
      await transport.close().catch(() => undefined);
      throw e;
    }
  }

  /** The project's document in `client`: already open, opened from disk, or created and saved. */
  async function projectDocument(client: FreeCADClient, path: string, label: string) {
    const docs = await client.listDocuments();
    let doc: DocumentInfo | undefined = docs.find((d) => d.fileName === path);
    if (!doc && (await exists(path))) doc = await client.openDocument(path);
    if (!doc) {
      doc = await client.newDocument({ name: "Model", label });
      doc = await client.saveDocumentAs(doc.name, path);
    }
    await client.setActiveDocument(doc.name);
    return doc.name;
  }

  async function connect(projectDir: string): Promise<Connection> {
    const bridge = deps.bridge();
    const path = join(projectDir, PROJECT_FILES.cadModel);
    const label = projectDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "Model";
    const live = (s: { state: string }) => s.state === "running";
    const sessions = await bridge.sessions();
    // A session the bridge started on this model.
    const byPath = sessions.find((s) => s.path === path && live(s));
    if (byPath) {
      const client = await attach(byPath.id);
      return { session: byPath.id, client, doc: await projectDocument(client, path, label), path };
    }
    // A bare session holding this model: created before the file existed (by a previous daemon).
    for (const s of sessions.filter((x) => x.path === null && live(x))) {
      const client = await attach(s.id).catch(() => null);
      if (!client) continue;
      const docs = await client.listDocuments().catch(() => [] as DocumentInfo[]);
      const doc = docs.find((d) => d.fileName === path);
      if (doc) {
        deps.log?.(`fab-cad: adopting bare session ${s.id} that holds ${path}`);
        await client.setActiveDocument(doc.name);
        return { session: s.id, client, doc: doc.name, path };
      }
      await client.close().catch(() => undefined);
    }
    const created = await bridge.createSession((await exists(path)) ? path : null);
    const client = await attach(created.id);
    return { session: created.id, client, doc: await projectDocument(client, path, label), path };
  }

  function connection(projectDir: string): Promise<Connection> {
    const cached = open.get(projectDir);
    if (cached) return cached;
    const pending = connect(projectDir).catch((e) => {
      open.delete(projectDir);
      throw e;
    });
    open.set(projectDir, pending);
    return pending;
  }

  async function drop(projectDir: string): Promise<Connection | null> {
    const pending = open.get(projectDir);
    open.delete(projectDir);
    const c = pending ? await pending.catch(() => null) : null;
    await c?.client.close().catch(() => undefined);
    return c;
  }

  async function run<T>(projectDir: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (e) {
      if (!isGone(e)) throw asToolError(e);
      deps.log?.(`fab-cad session for ${projectDir} is gone (${message(e)}); reconnecting`);
      await drop(projectDir);
      try {
        return await attempt();
      } catch (e2) {
        throw asToolError(e2);
      }
    }
    async function attempt() {
      return fn(await connection(projectDir));
    }
  }

  async function objects(c: Connection): Promise<ObjectInfo[]> {
    return c.client.getObjects(c.doc);
  }

  return {
    async status(): Promise<CadStatus> {
      const bridge = deps.bridge();
      try {
        const h = await bridge.health();
        const freecad = h.serverCommand?.join(" ") ?? null;
        return {
          bridgeUrl: bridge.url,
          reachable: true,
          detail: freecad
            ? `${h.sessions.length} session(s), workspace ${h.workspaceRoot ?? "?"}`
            : "the bridge has no FreeCAD API server (set FREECAD_API_SERVER on it)",
          freecad,
          ui: Boolean(h.staticDir),
        };
      } catch (e) {
        return {
          bridgeUrl: bridge.url,
          reachable: false,
          detail: message(e),
          freecad: null,
          ui: false,
        };
      }
    },

    model: (dir) =>
      run(dir, async (c) => {
        const [docs, list, stack] = await Promise.all([
          c.client.listDocuments(),
          objects(c),
          c.client.getUndoStack(c.doc),
        ]);
        return {
          document: c.doc,
          path: c.path,
          modified: docs.find((d) => d.name === c.doc)?.modified ?? false,
          objects: list.map(toObject),
          undo: stack.undo,
          redo: stack.redo,
        };
      }),

    properties: (dir, object, names) =>
      run(dir, async (c) => (await c.client.getProperties(c.doc, object, names)).map(toProperty)),

    addObject: (dir, input) =>
      run(dir, async (c) =>
        toObject(
          await c.client.addObject(c.doc, input.type, {
            ...(input.name ? { name: input.name } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.properties
              ? { properties: input.properties as Record<string, PropertyInput> }
              : {}),
            ...(input.group ? { group: input.group } : {}),
          }),
        ),
      ),

    setProperties: (dir, object, values) =>
      run(dir, async (c) =>
        (await c.client.setProperties(c.doc, object, values as Record<string, PropertyInput>)).map(
          toProperty,
        ),
      ),

    setExpression: (dir, object, path, expression) =>
      run(dir, async (c) => {
        await c.client.setExpression(c.doc, object, path, expression);
      }),

    removeObject: (dir, object, recursive) =>
      run(dir, async (c) => {
        await c.client.removeObject(c.doc, object, recursive);
      }),

    recompute: (dir) => run(dir, (c) => c.client.recompute(c.doc)),

    undo: (dir, redo) =>
      run(dir, async (c) => {
        const stack = redo ? await c.client.redo(c.doc) : await c.client.undo(c.doc);
        return { undo: stack.undo, redo: stack.redo };
      }),

    save: (dir) =>
      run(dir, async (c) => {
        await c.client.saveDocument(c.doc);
        return { path: c.path };
      }),

    export: (dir, input) =>
      run(dir, async (c) => {
        const names =
          input.objects ??
          (await objects(c))
            .filter((o) => o.isGeo && o.visibility && o.parents.length === 0)
            .map((o) => o.name);
        if (names.length === 0)
          throw new ToolError("the model has no visible shapes to export", "precondition");
        const file = await c.client.exportObjects(c.doc, names, input.format);
        return { data: file.data, fileName: file.fileName, objects: names };
      }),

    python: (dir, code, mode) =>
      run(dir, async (c) => {
        const r = await c.client.runPython(code, mode);
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          ...(r.repr !== undefined ? { repr: r.repr } : {}),
          ...(r.exception ? { exception: r.exception } : {}),
        };
      }),

    view: (dir) =>
      run(dir, async (c): Promise<CadView> => {
        // The URL names the session, so prove it is still alive (a dead one reconnects in `run`).
        await c.client.ping();
        const bridge = deps.bridge();
        const wsUrl = bridge.wsUrl(c.session);
        const h = await bridge.health().catch(() => null);
        return {
          bridgeUrl: bridge.url,
          session: c.session,
          wsUrl,
          uiUrl: h?.staticDir ? `${bridge.url}/?ws=${encodeURIComponent(wsUrl)}` : null,
          document: c.doc,
        };
      }),

    async release(dir) {
      const c = await drop(dir);
      if (c)
        await deps
          .bridge()
          .deleteSession(c.session)
          .catch(() => undefined);
    },

    async dispose() {
      for (const dir of [...open.keys()]) await drop(dir);
    },
  };
}

function toObject(o: ObjectInfo): CadObject {
  return {
    name: o.name,
    label: o.label,
    type: o.type,
    status: o.status,
    isError: o.isError,
    visibility: o.visibility,
    children: o.children,
    parents: o.parents,
    ...(o.bbox ? { bbox: { min: o.bbox.min, max: o.bbox.max } } : {}),
  };
}

function toProperty(p: PropertyInfo): CadProperty {
  return {
    name: p.name,
    type: p.type,
    group: p.group,
    value: plain(p.value),
    ...(p.unit ? { unit: p.unit } : {}),
    ...(p.expression ? { expression: p.expression } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    readOnly: p.status.includes("ReadOnly"),
  };
}

/** A wire value as JSON: byte strings (shapes, meshes) become their size. */
function plain(v: WireValue): unknown {
  if (v instanceof Uint8Array) return { $bytes: v.byteLength };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x as WireValue)]));
  return v;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isGone(e: unknown): boolean {
  if (e instanceof ToolError) return e.code === "not_found";
  if (e instanceof TransportError) return e.code === "closed" || e.code === "connect";
  if (FreeCADApiError.is(e, "TOKEN_MISMATCH")) return true;
  return /closed|not connected|ECONNRESET|unknown session/i.test(message(e));
}

/** FreeCAD's refusals are the agent's to fix; everything else says FreeCAD is not usable. */
function asToolError(e: unknown): Error {
  if (e instanceof ToolError) return e;
  if (e instanceof FreeCADApiError) {
    const code =
      e.status === "NOT_FOUND"
        ? "not_found"
        : e.status === "BAD_REQUEST"
          ? "invalid_args"
          : e.status === "FAILED"
            ? "precondition"
            : "unavailable";
    return new ToolError(`FreeCAD ${e.message}`, code);
  }
  if (e instanceof TransportError)
    return new ToolError(`FreeCAD session unreachable: ${e.message}`, "unavailable");
  return e instanceof Error ? e : new Error(String(e));
}
