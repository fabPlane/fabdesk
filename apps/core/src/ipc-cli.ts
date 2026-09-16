/** Search, describe, and call the pinned KiCad API directly over its nng IPC socket. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  IPC_CATALOG_SHA256,
  IPC_CATALOG_VERSION,
  IPC_SCHEMA_SHA256,
  IpcCallError,
  KICAD_COMMIT,
  KiCad,
  KiCadApiError,
  TransportError,
  callIpcOperation,
  commands,
  describeIpcOperation,
  searchIpcCatalog,
  type IpcCatalogSearch,
  type IpcCallResult,
  type KiCadClient,
} from "@fp-pcb/client";
import { NngIpcTransport } from "@fp-pcb/client/transport";
import { DocumentSpecifierSchema, DocumentType, type DocumentSpecifier } from "@fp-pcb/proto";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { VERSION, channel, fpPcbBridgeUrl } from "./config";

export type DirectIpcFailureCode =
  | "unknown_operation"
  | "unsupported"
  | "non_headless"
  | "invalid_schema"
  | "stale_document"
  | "timeout"
  | "kicad_status"
  | "unavailable";

export interface DirectIpcConnection {
  client: KiCadClient;
  session: { id: string; socketPath: string; kicadToken: string | null; kicadVersion: string };
  close(): Promise<void>;
}

export interface DirectIpcCallOptions {
  operation: string;
  request: JsonValue;
  projectDir?: string;
  bridgeUrl?: string;
  timeoutMs?: number;
  expectedDocumentRevision?: number;
}

type DirectIpcDeps = {
  connect?: (bridgeUrl: string, sessionPath: string | null) => Promise<DirectIpcConnection>;
  exists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<Uint8Array>;
  readRevision?: (client: KiCadClient, document: DocumentSpecifier) => Promise<number>;
  callOperation?: typeof callIpcOperation;
};

const catalog = {
  version: IPC_CATALOG_VERSION,
  sha256: IPC_CATALOG_SHA256,
  schemaSha256: IPC_SCHEMA_SHA256,
  kicadCommit: KICAD_COMMIT,
};

const runtime = () => ({
  runtimeId: process.env["FABDESK_RUNTIME_ID"] ?? null,
  fabdeskVersion: VERSION,
  channel: channel(),
});

export function directIpcSearch(search: IpcCatalogSearch): Record<string, unknown> {
  const results = searchIpcCatalog(search);
  return { ok: true, runtime: runtime(), catalog, count: results.length, results };
}

export function directIpcDescribe(operation: string, schemaDepth = 2): Record<string, unknown> {
  const description = describeIpcOperation(operation, schemaDepth);
  return description
    ? { ok: true, runtime: runtime(), ...description }
    : {
        ok: false,
        runtime: runtime(),
        catalog,
        failure: { code: "unknown_operation", message: `unknown KiCad IPC operation ${operation}` },
      };
}

function firstDocument(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    object["document"] &&
    typeof object["document"] === "object" &&
    !Array.isArray(object["document"])
  )
    return object["document"] as Record<string, unknown>;
  for (const child of Object.values(object)) {
    const found = firstDocument(child);
    if (found) return found;
  }
  return null;
}

function documentPath(
  projectDir: string | undefined,
  document: DocumentSpecifier | null,
): string | null {
  if (!projectDir || !document) return null;
  if (document.type === DocumentType.DOCTYPE_PCB)
    return join(
      projectDir,
      document.identifier.case === "boardFilename" && document.identifier.value
        ? document.identifier.value
        : "board.kicad_pcb",
    );
  if (document.type === DocumentType.DOCTYPE_SCHEMATIC) return join(projectDir, "board.kicad_sch");
  if (document.type === DocumentType.DOCTYPE_PROJECT) return join(projectDir, "board.kicad_pro");
  return null;
}

async function defaultConnect(
  bridgeUrl: string,
  sessionPath: string | null,
): Promise<DirectIpcConnection> {
  const session = await new FpPcbBridgeClient({ url: bridgeUrl }).sessionFor(sessionPath);
  if (!session.socketPath)
    throw new Error(`bridge session ${session.id} did not expose a direct KiCad IPC socket`);
  const transport = await NngIpcTransport.connect({ path: session.socketPath });
  try {
    const kicad = await KiCad.connect(transport, {
      clientName: `fabdesk/ipc-cli/${process.pid}`,
      ...(session.kicadToken ? { kicadToken: session.kicadToken } : {}),
    });
    const version = await kicad.version();
    return {
      client: kicad.client,
      session: {
        id: session.id,
        socketPath: session.socketPath,
        kicadToken: kicad.client.kicadToken ?? session.kicadToken ?? null,
        kicadVersion: version.fullVersion,
      },
      close: () => transport.close(),
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

function failure(code: DirectIpcFailureCode, message: string, detail?: Record<string, unknown>) {
  return { code, message, ...(detail && Object.keys(detail).length ? { detail } : {}) };
}

function mapFailure(error: unknown) {
  if (error instanceof IpcCallError) return failure(error.code, error.message, error.detail);
  if (error instanceof TransportError)
    return failure(error.code === "timeout" ? "timeout" : "unavailable", error.message, {
      transportCode: error.code,
    });
  if (error instanceof KiCadApiError)
    return failure(
      error.codeName === "AS_TIMEOUT"
        ? "timeout"
        : error.isUnsupported
          ? "unsupported"
          : "kicad_status",
      error.message,
      {
        status: error.codeName,
        serverMessage: error.serverMessage,
      },
    );
  return failure("unavailable", error instanceof Error ? error.message : String(error));
}

export async function directIpcCall(
  options: DirectIpcCallOptions,
  deps: DirectIpcDeps = {},
): Promise<Record<string, unknown>> {
  const description = describeIpcOperation(options.operation, 0);
  if (!description)
    return {
      ok: false,
      runtime: runtime(),
      catalog,
      failure: failure("unknown_operation", `unknown KiCad IPC operation ${options.operation}`),
    };
  if (description.headless === "gui-only")
    return {
      ok: false,
      runtime: runtime(),
      catalog,
      schema: { operationSha256: description.schemaHash },
      failure: failure(
        "non_headless",
        `${description.operation} is GUI-only and unavailable in kicad-cli api-server`,
      ),
    };
  if (description.headless !== "ok")
    return {
      ok: false,
      runtime: runtime(),
      catalog,
      schema: { operationSha256: description.schemaHash },
      failure: failure(
        "unsupported",
        `${description.operation} is not supported by the headless IPC catalog`,
      ),
    };

  const projectDir = options.projectDir ? resolve(options.projectDir) : undefined;
  const exists = deps.exists ?? ((path: string) => Bun.file(path).exists());
  const sessionPath = projectDir
    ? (await exists(join(projectDir, "board.kicad_pcb")))
      ? join(projectDir, "board.kicad_pcb")
      : (await exists(join(projectDir, "board.kicad_pro")))
        ? join(projectDir, "board.kicad_pro")
        : null
    : null;
  const requestDocument = firstDocument(options.request);
  let document: DocumentSpecifier | null = null;
  if (requestDocument) {
    try {
      document = fromJson(DocumentSpecifierSchema, requestDocument as JsonValue);
    } catch {
      // callIpcOperation supplies the complete request-schema error.
    }
  }
  const path = documentPath(projectDir, document);
  const readBytes = deps.readFile ?? ((file: string) => readFile(file));
  const fileHash = async () => {
    if (!path) return null;
    try {
      return createHash("sha256")
        .update(await readBytes(path))
        .digest("hex");
    } catch {
      return null;
    }
  };
  const beforeSha256 = await fileHash();
  let connection: DirectIpcConnection | undefined;
  try {
    connection = await (deps.connect ?? defaultConnect)(
      options.bridgeUrl ?? fpPcbBridgeUrl(undefined),
      sessionPath,
    );
    const readRevision =
      deps.readRevision ??
      (async (client: KiCadClient, target: DocumentSpecifier) =>
        Number(
          (await commands.getDocumentRevision(client, { document: target }, { retry: false }))
            .revision,
        ));
    let before: number | null = null;
    let revisionFailure: ReturnType<typeof mapFailure> | null = null;
    if (document) {
      try {
        before = await readRevision(connection.client, document);
      } catch (error) {
        revisionFailure = mapFailure(error);
      }
    }
    const base = {
      runtime: runtime(),
      operation: description.operation,
      transport: { kind: "nng-ipc", socketPath: connection.session.socketPath },
      session: connection.session,
      document: {
        specifier: document ? toJson(DocumentSpecifierSchema, document) : requestDocument,
        path,
        beforeSha256,
        afterSha256: beforeSha256,
      },
      revision: { expected: options.expectedDocumentRevision ?? null, before, after: before },
      catalog,
      schema: {
        operationSha256: description.schemaHash,
        requestType: description.requestType,
        responseType: description.responseType,
      },
    };
    if (options.expectedDocumentRevision !== undefined) {
      if (!document)
        return {
          ok: false,
          ...base,
          failure: failure(
            "invalid_schema",
            "expectedDocumentRevision requires a request containing a DocumentSpecifier",
          ),
        };
      if (revisionFailure) return { ok: false, ...base, failure: revisionFailure };
      if (before !== options.expectedDocumentRevision)
        return {
          ok: false,
          ...base,
          failure: failure(
            "stale_document",
            `document revision is ${before}, expected ${options.expectedDocumentRevision}`,
            {
              expected: options.expectedDocumentRevision,
              actual: before,
            },
          ),
        };
    }
    try {
      const called: IpcCallResult = await (deps.callOperation ?? callIpcOperation)(
        connection.client,
        options.operation,
        options.request,
        {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
      let after: number | null = null;
      if (document) {
        try {
          after = await readRevision(connection.client, document);
        } catch {
          after = null;
        }
      }
      return {
        ok: true,
        ...base,
        document: { ...base.document, afterSha256: await fileHash() },
        revision: { ...base.revision, after },
        response: called.response,
      };
    } catch (error) {
      return { ok: false, ...base, failure: mapFailure(error) };
    }
  } catch (error) {
    return {
      ok: false,
      runtime: runtime(),
      operation: description.operation,
      document: { specifier: requestDocument, path, beforeSha256, afterSha256: beforeSha256 },
      revision: { expected: options.expectedDocumentRevision ?? null, before: null, after: null },
      catalog,
      schema: {
        operationSha256: description.schemaHash,
        requestType: description.requestType,
        responseType: description.responseType,
      },
      failure: mapFailure(error),
    };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}
