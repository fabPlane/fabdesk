/**
 * Wire types for the FabPlane CAD bridge (`@fab-cad/bridge` on fabPlane/fab_cad), mirrored here
 * the way `./fp-pcb` mirrors the PCB bridge: `@fabdesk/core` talks HTTP to it and validates only
 * the fields it reads, so the bridge can grow without a lockstep release.
 *
 * Source of truth on fab_cad: `packages/bridge/README.md` and `packages/bridge/src/session.ts`
 * (`SessionInfo`). The FreeCAD API itself (the frames on `/ws`) is spoken through
 * `@fab-cad/client`, not mirrored.
 */
import { z } from "zod/v4";

export const FabCadSession = z.object({
  id: z.string(),
  /** `starting` | `running` | `exited` | `failed`. */
  state: z.string(),
  /** The document the session's `FreeCADApiServer` opened at start; null for a bare server. */
  path: z.string().nullable().default(null),
  /** FreeCAD instance token (`GetServerInfo`). */
  token: z.string().nullable().optional(),
  pid: z.number().int().nullable().optional(),
  error: z.string().nullable().optional(),
  clients: z.number().int().optional(),
});
export type FabCadSession = z.infer<typeof FabCadSession>;

export const FabCadHealth = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  /** The argv the bridge starts FreeCAD with; null when it has none (sessions then fail). */
  serverCommand: z.array(z.string()).nullable().optional(),
  workspaceRoot: z.string().optional(),
  /** Directory of the web UI the bridge serves; null when it serves none. */
  staticDir: z.string().nullable().optional(),
  sessions: z.array(FabCadSession).default([]),
});
export type FabCadHealth = z.infer<typeof FabCadHealth>;

/** `GET /projects/:id/cad/view`: where the desktop can show the project's live FreeCAD session. */
export const FabCadView = z.object({
  /** The bridge origin. */
  bridgeUrl: z.string(),
  session: z.string(),
  /** The session's WebSocket on the bridge (`/ws?session=…`), for a FreeCAD API client. */
  wsUrl: z.string(),
  /** The fab_cad web UI attached to that session; null when the bridge serves no UI. */
  uiUrl: z.string().nullable(),
  /** The FreeCAD document the project's model lives in. */
  document: z.string(),
});
export type FabCadView = z.infer<typeof FabCadView>;
