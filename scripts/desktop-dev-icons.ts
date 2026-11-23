// Regenerates apps/desktop/build/dev/: the app icon with a "DEV" band, shown by unpackaged
// (`bun run dev`) builds so they are easy to tell apart from an installed fabPlane in the dock,
// taskbar and app switcher. Run after the icon artwork changes: `bun run desktop:dev-icons`.
// The letters are drawn as shapes, so the output does not depend on installed fonts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rasterizeSvg } from "@fabdesk/kicad";

const build = join(import.meta.dir, "../apps/desktop/build");
const out = join(build, "dev");
const source = `data:image/png;base64,${readFileSync(join(build, "icon.png")).toString("base64")}`;

const BAND = "#ffb020";
const INK = "#1a1300";

// 1024-unit artwork. The band is masked by the icon's own alpha, so it follows the rounded shape.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="alpha" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"/>
    </filter>
    <mask id="shape" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <image xlink:href="${source}" width="1024" height="1024" filter="url(#alpha)"/>
    </mask>
  </defs>
  <image xlink:href="${source}" width="1024" height="1024"/>
  <g mask="url(#shape)">
    <rect x="0" y="715" width="1024" height="309" fill="${BAND}"/>
    <g fill="${INK}" transform="translate(330 745)">
      <path fill-rule="evenodd" d="M0 0h45a55 65 0 0 1 0 130h-45z M30 30h15a25 35 0 0 1 0 70h-15z"/>
      <path transform="translate(132 0)" d="M0 0h100v30h-70v20h55v30h-55v20h70v30h-100z"/>
      <path transform="translate(264 0)" d="M0 0h32l18 88 18-88h32l-34 130h-32z"/>
    </g>
  </g>
</svg>`;

async function png(width: number): Promise<Uint8Array> {
  return (await rasterizeSvg(svg, { maxWidth: width, background: "rgba(0,0,0,0)" })).png;
}

/** A single-image .ico that stores the 256 px PNG as is. */
function ico(png256: Uint8Array): Uint8Array {
  const head = new DataView(new ArrayBuffer(22));
  head.setUint16(2, 1, true); // type: icon
  head.setUint16(4, 1, true); // one image
  // width and height bytes stay 0, which means 256
  head.setUint16(10, 1, true); // planes
  head.setUint16(12, 32, true); // bits per pixel
  head.setUint32(14, png256.length, true);
  head.setUint32(18, 22, true); // offset of the image data
  return new Uint8Array([...new Uint8Array(head.buffer), ...png256]);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon.png"), await png(1024));
writeFileSync(join(out, "icon-512.png"), await png(512));
writeFileSync(join(out, "icon.ico"), ico(await png(256)));
console.log(`wrote ${out}/{icon.png,icon-512.png,icon.ico}`);
