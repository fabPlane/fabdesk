import { LedIndicator } from "./led-indicator";

/** Two-pin power header driving a current-limited LED. Offline: no @tsci imports. */
export default () => (
  <board width="20mm" height="15mm">
    <pinheader
      name="J1"
      pinCount={2}
      pitch="2.54mm"
      pcbX={-7}
      pcbY={0}
      schX={-4}
      pinLabels={["VCC", "GND"]}
    />
    <LedIndicator name="LED1" resistorName="R1" />
    <trace from="J1.pin1" to="R1.pin1" />
    <trace from="LED1.cathode" to="J1.pin2" />
  </board>
);
