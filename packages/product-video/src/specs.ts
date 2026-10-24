export type SpecsInput = {
  name: string;
  board?: {
    layers?: number;
    widthMm?: number;
    heightMm?: number;
  };
  components?: Array<{ ref: string; value: string; footprint?: string }>;
};

const MCU_RE =
  /\b(ESP32(?:-S[23]|-C[236]|-PICO)?|ESP8266|RP2040|RP2350|STM32[A-Z0-9]+|NRF52[0-9]*|ATSAMD[0-9A-Z]+|CH32V[0-9]+|PIC32[A-Z0-9]+|GD32[A-Z0-9]+|IMXRT[0-9]+|RA[46]M[0-9]+|MSP430[A-Z0-9]+|ATMEGA[0-9]+|ATTINY[0-9]+|PICO)\b/i;

/** Pull a short caption list from the project name, board settings and BOM. */
export function extractSpecs(input: SpecsInput): { name: string; lines: string[] } {
  const lines: string[] = [];
  const board = input.board;
  if (board?.widthMm && board.heightMm) lines.push(`${fmt(board.widthMm)} MM × ${fmt(board.heightMm)} MM`);
  if (board?.layers) lines.push(`${board.layers} LAYER${board.layers === 1 ? "" : "S"}`);
  const mcu = findMcu(input.components ?? []);
  if (mcu) lines.push(`MCU ${mcu}`);
  const n = input.components?.length ?? 0;
  if (n) lines.push(`${n} PART${n === 1 ? "" : "S"}`);
  return { name: input.name.trim() || "UNTITLED", lines };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function findMcu(components: Array<{ ref: string; value: string; footprint?: string }>): string | null {
  const scored = components
    .map((c) => {
      const blob = `${c.value} ${c.footprint ?? ""}`;
      const m = blob.match(MCU_RE);
      return m ? { ref: c.ref, value: m[1]!.toUpperCase(), prefer: /^U\d/i.test(c.ref) } : null;
    })
    .filter((x): x is { ref: string; value: string; prefer: boolean } => x !== null);
  scored.sort((a, b) => Number(b.prefer) - Number(a.prefer));
  return scored[0]?.value ?? null;
}
