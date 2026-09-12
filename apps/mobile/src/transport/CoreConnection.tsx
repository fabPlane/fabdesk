/**
 * Holds the live connection to a paired desktop and puts it under the shared CoreProvider.
 *
 * Three things differ from the Electron renderer, all of them phone-shaped:
 * the event stream is a WebSocket (React Native has no EventSource, and its fetch cannot stream);
 * the base URL is discovered by probing, because a laptop moves between networks; and the daemon's
 * event ids restart at zero whenever it does, so a changed pid drops the resume cursor and refetches.
 */
import { CoreProvider, DirectTransport, useCore, type CoreEventSubscribe, type SseStatus } from "@fabdesk/client-core";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { connectOrder, readToken, useConnections, type Connection } from "./connections";
import { findReachable, type HealthInfo } from "./connect";

export type ConnectionPhase = "idle" | "locating" | "connecting" | "ready" | "unreachable" | "unauthorized";

export interface CoreConnectionValue {
  connection: Connection | null;
  phase: ConnectionPhase;
  status: SseStatus;
  health: HealthInfo | null;
  baseUrl: string | null;
  /** For the few places that need a raw authenticated request — image loading, mostly. */
  authHeaders: Record<string, string>;
  error: string | null;
  retry: () => void;
}

const Ctx = createContext<CoreConnectionValue | null>(null);

export function useConnection(): CoreConnectionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnection must be used inside <CoreConnectionProvider>");
  return v;
}

const queryClient = new QueryClient({
  // A phone drops in and out of network constantly; one retry and a short stale window keep the
  // screens from flapping without hiding real staleness.
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
});

export function CoreConnectionProvider({ children }: { children: ReactNode }) {
  const { connections, activeId, hydrated, noteConnected } = useConnections();
  const connection = useMemo(() => connections.find((c) => c.id === activeId) ?? null, [connections, activeId]);

  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [transport, setTransport] = useState<DirectTransport | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useMemo(() => () => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!hydrated) return;
    if (!connection) {
      setPhase("idle");
      setTransport(null);
      return;
    }
    let cancelled = false;
    setPhase("locating");
    setError(null);
    void (async () => {
      const token = await readToken(connection.id);
      if (cancelled) return;
      if (!token) {
        setPhase("unauthorized");
        setError("This device's credential is gone. Pair again from the desktop.");
        return;
      }
      const found = await findReachable(connectOrder(connection));
      if (cancelled) return;
      if (!found) {
        setPhase("unreachable");
        setError(`Could not reach ${connection.name}. Is it awake and on the same tailnet?`);
        return;
      }
      setHealth(found.health);
      if (found.baseUrl !== connection.baseUrl) void noteConnected(connection.id, found.baseUrl);
      setTransport(new DirectTransport({ id: connection.id, baseUrl: found.baseUrl, token }));
      setPhase("connecting");
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, hydrated, attempt, noteConnected]);

  useEffect(() => () => transport?.dispose(), [transport]);

  // `useCoreEvents` reopens the stream whenever this callback changes, so it must be stable for
  // the life of a transport: an inline arrow here made every re-render — including the one
  // `setHealth` causes on each successful open — tear the socket down and dial again, forever.
  const subscribe = useCallback<CoreEventSubscribe>(
    (topics, onEvent, onStatus) => {
      if (!transport) throw new Error("no transport");
      return openEvents(transport, topics, onEvent, onStatus, queryClient, setHealth);
    },
    [transport],
  );

  const offline = useMemo<CoreConnectionValue>(
    () => ({ connection, phase, status: "closed", health, baseUrl: null, authHeaders: {}, error, retry }),
    [connection, phase, health, error, retry],
  );

  if (!transport) return <Ctx.Provider value={offline}>{children}</Ctx.Provider>;

  return (
    <CoreProvider
      client={transport.client()}
      queryClient={queryClient}
      subscribe={subscribe}
    >
      <Bridge base={offline} transport={transport} onPhase={setPhase}>
        {children}
      </Bridge>
    </CoreProvider>
  );
}

/**
 * The daemon numbers its events from zero again after a restart, and only replays the last 500 per
 * topic, so a stale cursor would silently skip everything. `/health` carries the pid: a changed one
 * means start clean and refetch rather than resume.
 */
function openEvents(
  transport: DirectTransport,
  topics: string[],
  onEvent: (event: Parameters<Parameters<DirectTransport["openEvents"]>[0]["onEvent"]>[0], id: string) => void,
  onStatus: (status: SseStatus) => void,
  qc: QueryClient,
  onHealth: (h: HealthInfo) => void,
) {
  let pid: number | null = null;
  return transport.openEvents({
    topics,
    onEvent,
    onStatus,
    canResume: async () => {
      const next = (await transport
        .client()
        .health()
        .catch(() => null)) as HealthInfo | null;
      if (!next) return false;
      onHealth(next);
      const restarted = pid !== null && pid !== next.pid;
      pid = next.pid;
      if (restarted) void qc.invalidateQueries();
      return !restarted;
    },
  });
}

/** Inside the provider, so it can read the stream status the provider tracks. */
function Bridge({
  base,
  transport,
  onPhase,
  children,
}: {
  base: CoreConnectionValue;
  transport: DirectTransport;
  onPhase: (p: ConnectionPhase) => void;
  children: ReactNode;
}) {
  const { sseStatus } = useCore();
  const qc = useQueryClient();
  const wasOpen = useRef(false);

  useEffect(() => {
    onPhase(sseStatus === "open" ? "ready" : "connecting");
    // A reconnect after a gap may have missed events beyond the bus's replay window; the cheapest
    // correct answer is to refetch what is on screen.
    if (sseStatus === "open" && wasOpen.current) void qc.invalidateQueries();
    if (sseStatus === "open") wasOpen.current = true;
  }, [sseStatus, onPhase, qc]);

  const value = useMemo<CoreConnectionValue>(
    () => ({ ...base, status: sseStatus, baseUrl: transport.baseUrl(), authHeaders: transport.authHeaders() }),
    [base, sseStatus, transport],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
