import type { ReactNode } from "react";

/** Original vector illustrations, not generated project files or fabrication previews. */
function Example({ label, children, color }: { label: string; children: ReactNode; color: string }) {
  return <figure>
    <svg viewBox="0 0 160 108" role="img" aria-label={`${label} artwork illustration`}>
      <rect x="3" y="3" width="154" height="102" rx="13" fill={color} />
      <rect x="8" y="8" width="144" height="92" rx="9" fill="none" stroke="#e4cf92" strokeOpacity=".5" />
      {[[15, 15], [145, 15], [15, 93], [145, 93]].map(([x, y], index) => <g key={index}><circle cx={x} cy={y} r="4" fill="#d6bc78" /><circle cx={x} cy={y} r="2" fill={color} /></g>)}
      <g fill="#f6eace" stroke="#f6eace" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</g>
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

const dots = Array.from({ length: 13 * 9 }, (_, index) => {
  const x = 38 + (index % 13) * 7, y = 26 + Math.floor(index / 13) * 7;
  const distance = Math.hypot(x - 80, y - 54);
  return distance < 34 ? <circle key={index} cx={x} cy={y} r={Math.max(.65, 2.9 - Math.abs(x - 69) / 18)} stroke="none" /> : null;
});

export function ArtworkInspiration() {
  return <div className="fd-art-inspiration" aria-label="Artwork inspiration · illustrative examples">
    <p>A little inspiration <span>Illustrative examples</span></p>
    <div className="fd-art-inspiration-examples">
      <Example label="Bold marks" color="#175c49">
        <circle cx="80" cy="54" r="16" stroke="none" />
        {Array.from({ length: 12 }, (_, index) => <path key={index} d="M80 26v-8" strokeWidth="4" transform={`rotate(${index * 30} 80 54)`} />)}
      </Example>
      <Example label="Line art" color="#294a68">
        <g fill="none"><path d="m29 70 30-35 24 27 16-17 32 31M41 76h80M50 81h62" /><path d="m51 45 8 7 8-7M92 53l7 6 6-5" /></g>
        <circle cx="111" cy="31" r="7" stroke="none" />
      </Example>
      <Example label="Halftone" color="#624b75">{dots}</Example>
    </div>
  </div>;
}
