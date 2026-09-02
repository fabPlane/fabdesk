/**
 * Where the router worker lives. In a `bun build --compile` binary the extra entrypoint is embedded
 * under `/$bunfs/root/<path relative to --root>`; `scripts/build.ts` defines FABDESK_ROUTER_WORKER
 * with that path. In dev, `RouterHost` resolves the worker next to the router package itself.
 */
declare const FABDESK_ROUTER_WORKER: string | undefined;

export function routerWorkerUrl(): URL | undefined {
  const embedded = typeof FABDESK_ROUTER_WORKER === "string" ? FABDESK_ROUTER_WORKER : undefined;
  if (!embedded) return undefined;
  return new URL(`file://${embedded}`);
}

export function routerHostOptions(): { workerUrl?: URL } {
  const workerUrl = routerWorkerUrl();
  return workerUrl ? { workerUrl } : {};
}
