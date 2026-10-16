import type { SVGProps } from "react";

/** Shared circuit mark used by the welcome screen and board workspace. */
export function CircuitLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="8" y="8" width="36" height="36" rx="7" />
      <path d="M8 20h10l7 7h10M44 18h-8l-6 6M18 44v-9l7-8" />
      <circle cx="18" cy="20" r="2" fill="currentColor" /><circle cx="35" cy="27" r="2" fill="currentColor" /><circle cx="30" cy="24" r="2" fill="currentColor" />
    </svg>
  );
}
