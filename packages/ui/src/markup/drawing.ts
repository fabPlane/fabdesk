const svgByHost = new WeakMap<HTMLElement, string>();

/** SvgViewer registers the live drawing so markup capture can hit-test without cloning the DOM. */
export function bindMarkupDrawing(host: HTMLElement, svg: string): void {
  svgByHost.set(host, svg);
}

export function unbindMarkupDrawing(host: HTMLElement): void {
  svgByHost.delete(host);
}

export type MarkupClientBox = { left: number; top: number; right: number; bottom: number };

export function markupSvgFor(
  root: ParentNode,
  region?: MarkupClientBox,
): { host: HTMLElement; svg: string } | null {
  const hosts = [...root.querySelectorAll<HTMLElement>(".fd-svg-host")].filter((host) => svgByHost.has(host));
  if (hosts.length === 0) return null;
  const pick =
    (region && hostWithLargestIntersection(hosts, region)) ||
    hosts.find((host) => host.closest("[data-active='true']")) ||
    hosts[0];
  const svg = pick ? svgByHost.get(pick) : undefined;
  return pick && svg ? { host: pick, svg } : null;
}

function hostWithLargestIntersection(hosts: HTMLElement[], region: MarkupClientBox): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let area = 0;
  for (const host of hosts) {
    const next = intersectionArea(host.getBoundingClientRect(), region);
    if (next > area) {
      best = host;
      area = next;
    }
  }
  return best;
}

function intersectionArea(a: DOMRect, b: MarkupClientBox): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}
