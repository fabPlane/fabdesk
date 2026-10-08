import { FabCadView, type CadRuntimeBridge, type CadRuntimeState } from "@fabdesk/protocol";

export interface CadSessionState {
  runtime: CadRuntimeState | null;
  busy: boolean;
  view: FabCadView | null;
  error: string | null;
}

/** Owns async CAD requests; stale projects and disposed views never receive their results. */
export class CadSession {
  state: CadSessionState = { runtime: null, busy: false, view: null, error: null };
  private generation = 0;
  private pending = false;
  private disposed = false;
  constructor(
    private readonly bridge: CadRuntimeBridge | undefined,
    private readonly view: () => Promise<unknown>,
    private readonly changed: (state: CadSessionState) => void,
  ) {}
  private update(patch: Partial<CadSessionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  resume() {
    this.disposed = false;
    this.pending = false;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
  }
  async refresh(reconnect = false) {
    if (this.pending || this.disposed) return;
    this.pending = true;
    const generation = ++this.generation;
    this.update({ busy: true, error: null, view: null });
    try {
      if (this.bridge) {
        const runtime = await (reconnect && this.bridge.reconnectCadRuntime
          ? this.bridge.reconnectCadRuntime()
          : this.bridge.prepareCadRuntime());
        if (generation !== this.generation) return;
        this.update({ runtime });
        if (runtime.status !== "ready") return;
      }
      const parsed = FabCadView.safeParse(await this.view());
      if (generation !== this.generation) return;
      this.update(
        parsed.success
          ? { view: parsed.data }
          : { error: "The CAD bridge returned an unexpected response." },
      );
    } catch {
      if (generation === this.generation)
        this.update({
          error: "We couldn’t connect to the CAD bridge. Retry to reconnect your project.",
        });
    } finally {
      if (generation === this.generation) {
        this.pending = false;
        this.update({ busy: false });
      }
    }
  }
  async install() {
    if (!this.bridge || this.pending || this.disposed) return;
    this.pending = true;
    const generation = ++this.generation;
    this.update({ busy: true, error: null });
    try {
      const runtime = await this.bridge.downloadCadRuntime();
      if (generation !== this.generation) return;
      this.update({ runtime });
      this.pending = false;
      if (runtime.status === "ready") await this.refresh();
    } catch {
      if (generation === this.generation)
        this.update({ error: "CAD installation could not finish. Try again." });
    } finally {
      if (generation === this.generation) {
        this.pending = false;
        this.update({ busy: false });
      }
    }
  }
  async poll() {
    if (!this.bridge || this.disposed) return;
    const generation = this.generation;
    try {
      const runtime = await this.bridge.cadRuntimeState();
      if (generation !== this.generation) return;
      const becameReady = this.state.runtime?.status !== "ready";
      this.update({ runtime });
      // A download may have continued while this tab was closed.
      if (runtime.status === "ready" && becameReady && !this.pending && !this.state.view)
        await this.refresh();
    } catch {
      /* Keep the last known state; Retry remains available. */
    }
  }
  async cancel() {
    if (!this.bridge || this.disposed) return;
    // Keep the install request locked until it settles, including native consent dismissal.
    try {
      await this.bridge.cancelCadRuntime();
      this.update({ runtime: await this.bridge.deferCadRuntime() });
    } catch {
      this.update({ error: "Couldn’t cancel CAD setup. Try again." });
    }
  }
}
