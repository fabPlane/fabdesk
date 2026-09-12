/**
 * Holds the live connection to a paired desktop and puts it under the shared CoreProvider.
 *
 * Three things differ from the Electron renderer, all of them phone-shaped:
 * the event stream is a WebSocket (React Native has no EventSource, and its fetch cannot stream);
 * the base URL is discovered by probing, because a laptop moves between networks; and the daemon's
 * event ids restart at zero whenever it does, so a changed pid drops the resume cursor and refetches.
 *
 * A phone also sleeps and roams. Coming back to the foreground, or changing network, re-probes
 * every saved address: a different one answering means switching transports, a dead stream on the
 * same one means dialling again now instead of waiting out the backoff.
 */
import { CoreProvider, DirectTransport, useCore, type CoreEventSubscribe, type SseStatus } from "@fabdesk/client-core";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { isForegroundReturn, nextStaleSince, planAfterReprobe, shouldReprobeOnNetwork } from "../lib/reconnect";
import { connectOrder, readToken, useConnections, type Connection } from "./connections";
import { findReachable, type HealthInfo } from "./connect";

export type ConnectionPhase = "idle" | "locating" | "connecting" | "ready" | "unreachable" | "unauthorized";

export interface CoreConnectionValue {
  connection: Connection | null;
  phase: ConnectionPhase;
  status: SseStatus;
  /**
   * When the event stream last dropped out of `open` (ms since epoch), null while it is open or
   * has never been. Screens turn it into "Reconnecting for 30 s…"; a cold start is not stale.
   */
  staleSince: number | null;
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

/** A re-probe after a foreground return or network change has a short fuse: the user is looking. */
const REPROBE_TIMEOUT_MS = 2000;

export function CoreConnectionProvider({ children }: { children: ReactNode }) {
  const { connections, activeId, hydrated, noteConnected } = useConnections();
  const connection = useMemo(() => connections.find((c) => c.id === activeId) ?? null, [connections, activeId]);

  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [transport, setTransport] = useState<DirectTransport | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  // Bumping this changes `subscribe`'s identity, which is the one sanctioned way to make
  // `useCoreEvents` close the socket and dial again. It moves only from a deliberate re-probe.
  const [streamEpoch, setStreamEpoch] = useState(0);
  const retry = useMemo(() => () => setAttempt((n) => n + 1), []);

  // What the re-probe reads. Refs, so the AppState/network listeners are installed once and never
  // see a stale closure.
  const streamStatus = useRef<SseStatus>("closed");
  const latest = useRef({ connection, transport, phase });
  useEffect(() => {
    latest.current = { connection, transport, phase };
  }, [connection, transport, phase]);
  const reprobing = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    if (!connection) {
      setPhase("idle");
      setTransport(null);
      setStaleSince(null);
      streamStatus.current = "closed";
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

  /**
   * Foreground return or network change. Never touches `phase` while a transport exists — going
   * back to "locating" would unmount every screen under the gate and lose what the user was
   * looking at — so a dead address shows as the stream reconnecting, which the Chats screen already
   * renders, until an address answers.
   */
  const reprobe = useCallback(async () => {
    const { connection: conn, transport: current, phase: ph } = latest.current;
    if (!conn || reprobing.current) return;
    if (!current) {
      // Nothing to keep alive: a failed initial locate is worth another go, anything else is
      // either in flight or needs the desktop (a revoked token).
      if (ph === "unreachable") retry();
      return;
    }
    reprobing.current = true;
    try {
      const found = await findReachable(connectOrder(conn), { timeoutMs: REPROBE_TIMEOUT_MS });
      if (latest.current.transport !== current) return; // replaced meanwhile; that path re-probed already
      const plan = planAfterReprobe({
        found: found?.baseUrl ?? null,
        currentBaseUrl: current.baseUrl(),
        streamStatus: streamStatus.current,
      });
      if (found) setHealth(found.health);
      if (plan.kind === "switch") {
        const token = await readToken(conn.id);
        if (!token || latest.current.transport !== current) return;
        void noteConnected(conn.id, plan.baseUrl);
        setTransport(new DirectTransport({ id: conn.id, baseUrl: plan.baseUrl, token }));
      } else if (plan.kind === "reopen") {
        setStreamEpoch((n) => n + 1);
      } else if (plan.kind === "relocate") {
        retry();
      }
    } finally {
      reprobing.current = false;
    }
  }, [noteConnected, retry]);

  useEffect(() => {
    let prevApp: AppStateStatus | null = AppState.currentState;
    const app = AppState.addEventListener("change", (next) => {
      if (isForegroundReturn(prevApp, next)) void reprobe();
      prevApp = next;
    });
    // Seed the previous network state so the first change event is compared against reality,
    // not against "unknown" — otherwise every launch would pay for one needless probe.
    let prevNet: Network.NetworkState | null = null;
    void Network.getNetworkStateAsync()
      .then((s) => {
        prevNet ??= s;
      })
      .catch(() => {});
    const net = Network.addNetworkStateListener((next) => {
      if (shouldReprobeOnNetwork(prevNet, next)) void reprobe();
      prevNet = next;
    });
    return () => {
      app.remove();
      net.remove();
    };
  }, [reprobe]);

  // `useCoreEvents` reopens the stream whenever this callback changes, so it must be stable for
  // the life of a transport: an inline arrow here made every re-render — including the one
  // `setHealth` causes on each successful open — tear the socket down and dial again, forever.
  // `streamEpoch` is in the list on purpose: it is how a re-probe asks for one fresh dial.
  const subscribe = useCallback<CoreEventSubscribe>(
    (topics, onEvent, onStatus) => {
      if (!transport) throw new Error("no transport");
      return openEvents(transport, topics, onEvent, onStatus, queryClient, setHealth);
    },
    [transport, streamEpoch],
  );

  const onStreamStatus = useCallback((next: SseStatus) => {
    const prev = streamStatus.current;
    streamStatus.current = next;
    setStaleSince((cur) => nextStaleSince(prev, next, cur, Date.now()));
  }, []);

  const offline = useMemo<CoreConnectionValue>(
    () => ({ connection, phase, status: "closed", staleSince, health, baseUrl: null, authHeaders: {}, error, retry }),
    [connection, phase, staleSince, health, error, retry],
  );

  if (!transport) return <Ctx.Provider value={offline}>{children}</Ctx.Provider>;

  return (
    <CoreProvider
      client={transport.client()}
      queryClient={queryClient}
      subscribe={subscribe}
    >
      <Bridge base={offline} transport={transport} onPhase={setPhase} onStreamStatus={onStreamStatus}>
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
  onStreamStatus,
  children,
}: {
  base: CoreConnectionValue;
  transport: DirectTransport;
  onPhase: (p: ConnectionPhase) => void;
  onStreamStatus: (s: SseStatus) => void;
  children: ReactNode;
}) {
  const { sseStatus } = useCore();
  const qc = useQueryClient();
  const wasOpen = useRef(false);

  useEffect(() => {
    onPhase(sseStatus === "open" ? "ready" : "connecting");
    onStreamStatus(sseStatus);
    // A reconnect after a gap may have missed events beyond the bus's replay window; the cheapest
    // correct answer is to refetch what is on screen.
    if (sseStatus === "open" && wasOpen.current) void qc.invalidateQueries();
    if (sseStatus === "open") wasOpen.current = true;
  }, [sseStatus, onPhase, onStreamStatus, qc]);

  const value = useMemo<CoreConnectionValue>(
    () => ({ ...base, status: sseStatus, baseUrl: transport.baseUrl(), authHeaders: transport.authHeaders() }),
    [base, sseStatus, transport],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
