/** Small CAD-specific icons using the same stroke language as the app chrome. */
export function MechanicalIcon({
  name,
}: {
  name: "cube" | "eye" | "eyeOff" | "fit" | "undo" | "redo";
}) {
  const paths = {
    cube: (
      <>
        <path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z" />
        <path d="m3 8 9 5 9-5m-9 5v8M8 5l9 5" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    eyeOff: (
      <>
        <path d="m3 3 18 18M9 5.5A11 11 0 0 1 12 5c6 0 10 7 10 7a21 21 0 0 1-3 4M6 7a24 24 0 0 0-4 5s4 7 10 7c1.5 0 3-.4 4-1" />
      </>
    ),
    fit: (
      <>
        <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />
        <rect x="8" y="8" width="8" height="8" rx="1" />
      </>
    ),
    undo: (
      <>
        <path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12" />
      </>
    ),
    redo: (
      <>
        <path d="m15 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
      </>
    ),
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
