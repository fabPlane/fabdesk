import type { RouterList } from "@fabdesk/protocol";
import type { DesignStatus } from "@fabdesk/tools";

/** Keep installation facts intact while exposing what the active PCB bridge can actually run. */
export function withRouterRuntime(list: RouterList, status: DesignStatus): RouterList {
  return { ...list, routers: list.routers.map(router => {
    const engine = router.id === "tracemaker" ? null : status.routers?.[router.id];
    const ready = router.ready && status.ok && status.kicadCliExists !== false && (router.id === "tracemaker" || engine?.ok === true);
    const reason = !router.ready ? router.installHint : !status.ok ? status.reason ?? "The PCB backend could not be reached." : status.kicadCliExists === false ? "The PCB backend cannot find its KiCad runtime." : engine?.ok === false ? engine.reason ?? "This engine is unavailable on the active PCB backend." : !ready ? "The PCB backend did not report this engine’s availability." : undefined;
    return { ...router, runtime: { ready, ...(reason ? { reason } : {}) } };
  }) };
}
