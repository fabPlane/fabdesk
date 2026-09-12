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
 *
 * The other saved computers get a status too (`useEnvironmentStatus`): a `/health` probe of each
 * one's addresses every minute, but only while a screen that shows the dots is mounted.
 */
import {
  CoreProvider,
  DirectTransport,
  routeFrameHub,
  useCore,
  type CoreEventSubscribe,
  type SseStatus,
} from "@fabdesk/client-core";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import { create } from "zustand";
import {
  STATUS_PROBE_INTERVAL_MS,
  effectiveStatus,
  probeDue,
  probeEnvironments,
  type EnvironmentStatus,
  type StatusEntry,
} from "../lib/environments";
import {
  isForegroundReturn,
  nextStaleSince,
  planAfterReprobe,
  shouldReprobeOnNetwork,
} from "../lib/reconnect";
import { PushRegistrar } from "../notifications/PushRegistrar";
import { notifyForEvent } from "../notifications/run-notifier";
import { connectOrder, readToken, useConnections, type Connection } from "./connections";
import { findReachable, type HealthInfo } from "./connect";

export type ConnectionPhase =
  | "idle"
  | "locating"
  | "connecting"
  | "ready"
  | "unreachable"
  | "unauthorized";

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

/* ---------- status of every saved computer ---------- */

interface EnvironmentStatusState {
  statuses: Record<string, StatusEntry>;
  /** A round is in flight (pull-to-refresh shows its spinner off this). */
  probing: boolean;
  /** Probes every saved computer now, coalescing with a round already in flight. */
  refresh: () => Promise<void>;
}

let probeRound: Promise<void> | null = null;

/**
 * Not persisted: a status is a snapshot of the network a minute ago and means nothing after a
 * relaunch. Probing is driven by `useStatusProbing`, not by the store, so nothing runs while no
 * screen shows the dots.
 */
export const useEnvironmentStatus = create<EnvironmentStatusState>()((set) => ({
  statuses: {},
  probing: false,
  refresh: () => {
    if (probeRound) return probeRound;
    set({ probing: true });
    probeRound = probeEnvironments(useConnections.getState().connections, async (env) => {
      const found = await findReachable(connectOrder(env), { timeoutMs: REPROBE_TIMEOUT_MS });
      return found?.baseUrl ?? null;
    })
      .then((next) => set((s) => ({ statuses: { ...s.statuses, ...next } })))
      .finally(() => {
        probeRound = null;
        set({ probing: false });
      });
    return probeRound;
  },
}));

/**
 * Keeps the statuses fresh while `enabled`: one round on mount unless a recent one exists, then
 * every `STATUS_PROBE_INTERVAL_MS`. Several screens may want it at once (the switcher sheet over
 * the Connections screen); a ref count keeps one timer between them.
 */
let probingSubscribers = 0;
let probingTimer: ReturnType<typeof setInterval> | null = null;

export function useStatusProbing(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const { refresh } = useEnvironmentStatus.getState();
    if (probingSubscribers++ === 0) {
      probingTimer = setInterval(() => void refresh(), STATUS_PROBE_INTERVAL_MS);
    }
    const ids = useConnections.getState().connections.map((c) => c.id);
    if (probeDue(useEnvironmentStatus.getState().statuses, ids, Date.now())) void refresh();
    return () => {
      if (--probingSubscribers === 0 && probingTimer) {
        clearInterval(probingTimer);
        probingTimer = null;
      }
    };
  }, [enabled]);
}

/**
 * The status to show for one saved computer. For the active one the live connection outranks the
 * probe (an open stream is proof; a failed locate is proof of the opposite).
 */
export function useEnvironmentStatusOf(id: string): EnvironmentStatus {
  const entry = useEnvironmentStatus((s) => s.statuses[id]);
  const { connection, status, phase } = useConnection();
  const live =
    connection?.id === id
      ? { streamOpen: status === "open", unreachable: phase === "unreachable" }
      : null;
  return effectiveStatus(entry, live);
}

export function CoreConnectionProvider({ children }: { children: ReactNode }) {
  const { connections, activeId, hydrated, noteConnected, noteCoreId } = useConnections();
  const connection = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

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

  // `/health` is the one place a daemon's `coreId` reliably arrives (pairing may predate it, and
  // the pairing schema may strip it); notifications name the daemon by it.
  const noteHealth = useCallback(
    (h: HealthInfo) => {
      setHealth(h);
      const conn = latest.current.connection;
      if (h.coreId && conn && conn.coreId !== h.coreId) void noteCoreId(conn.id, h.coreId);
    },
    [noteCoreId],
  );

  // Keyed on the connection's id, not the record: the store rewrites the record on every connect
  // (address, `lastConnectedAt`, `coreId`), and none of that should tear the transport down.
  const connectionId = connection?.id ?? null;
  const previousId = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    // Switching computers: the query cache is one object shared by every transport, so what it
    // holds is the other machine's threads. Drop it before the gate lets the screens back in,
    // rather than letting them flash the wrong list until the refetch lands.
    if (previousId.current !== null && previousId.current !== connectionId) {
      queryClient.clear();
      setHealth(null);
    }
    previousId.current = connectionId;
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
      noteHealth(found.health);
      if (found.baseUrl !== connection.baseUrl) void noteConnected(connection.id, found.baseUrl);
      setTransport(new DirectTransport({ id: connection.id, baseUrl: found.baseUrl, token }));
      setPhase("connecting");
    })();
    return () => {
      cancelled = true;
    };
    // `connection` is deliberately not a dependency; see the note above `connectionId`.
  }, [connectionId, hydrated, attempt, noteConnected, noteHealth]);

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
      if (found) noteHealth(found.health);
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
  }, [noteConnected, noteHealth, retry]);

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
  // Every event is offered to the local notifier first (docs/mobile-notifications.md §3.3): it
  // needs the run store as it was before the reducer ends the run, and it reads the connection
  // through `latest` so the callback stays stable.
  const subscribe = useCallback<CoreEventSubscribe>(
    (topics, onEvent, onStatus) => {
      if (!transport) throw new Error("no transport");
      return openEvents(
        transport,
        topics,
        (event, id) => {
          const conn = latest.current.connection;
          if (conn) notifyForEvent(event, { connection: conn, qc: queryClient });
          onEvent(event, id);
        },
        onStatus,
        queryClient,
        noteHealth,
      );
    },
    [transport, streamEpoch, noteHealth],
  );

  const onStreamStatus = useCallback((next: SseStatus) => {
    const prev = streamStatus.current;
    streamStatus.current = next;
    setStaleSince((cur) => nextStaleSince(prev, next, cur, Date.now()));
  }, []);

  const offline = useMemo<CoreConnectionValue>(
    () => ({
      connection,
      phase,
      status: "closed",
      staleSince,
      health,
      baseUrl: null,
      authHeaders: {},
      error,
      retry,
    }),
    [connection, phase, staleSince, health, error, retry],
  );

  if (!transport) return <Ctx.Provider value={offline}>{children}</Ctx.Provider>;

  return (
    <CoreProvider
      client={transport.client()}
      queryClient={queryClient}
      subscribe={subscribe}
      // Live routing frames fan out to whichever cinema screen is open.
      route={routeFrameHub}
    >
      <Bridge
        base={offline}
        transport={transport}
        onPhase={setPhase}
        onStreamStatus={onStreamStatus}
      >
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
  onEvent: (
    event: Parameters<Parameters<DirectTransport["openEvents"]>[0]["onEvent"]>[0],
    id: string,
  ) => void,
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
    () => ({
      ...base,
      status: sseStatus,
      baseUrl: transport.baseUrl(),
      authHeaders: transport.authHeaders(),
    }),
    [base, sseStatus, transport],
  );
  return (
    <Ctx.Provider value={value}>
      {/* Tells this daemon about the phone's push token on every open (§3.1). */}
      <PushRegistrar connectionId={transport.id} />
      {children}
    </Ctx.Provider>
  );
}
