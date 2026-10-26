/** Chromium / Electron on-device speech, when the engine ships it. */

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: BrowserSpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

export interface BrowserSpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
}

export type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

export function speechRecognitionCtor(
  globalObj: typeof globalThis = globalThis,
): SpeechRecognitionCtor | null {
  const g = globalObj as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export function webSpeechAvailable(globalObj: typeof globalThis = globalThis): boolean {
  return speechRecognitionCtor(globalObj) !== null;
}

export function transcriptsFromEvent(event: BrowserSpeechResultEvent): { partial: string; final: string } {
  let partial = "";
  let final = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const row = event.results[i];
    const text = row?.[0]?.transcript?.trim() ?? "";
    if (!text) continue;
    if (row?.isFinal) final = final ? `${final} ${text}` : text;
    else partial = partial ? `${partial} ${text}` : text;
  }
  return { partial, final };
}
