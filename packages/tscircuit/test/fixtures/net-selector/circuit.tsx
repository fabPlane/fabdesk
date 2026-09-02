// Rails wired through <net> elements and net selectors rather than pin-to-pin traces, so the
// router receives one connection per net (named by its source_net_id) instead of per trace.
export default () => (
  <board width="30mm" height="20mm">
    <net name="GND" />
    <net name="V5" />
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={-8} pcbY={0} pcbRotation={90} />
    <capacitor name="C1" capacitance="100nF" footprint="0603" pcbX={0} pcbY={0} pcbRotation={90} />
    <resistor name="R2" resistance="2k" footprint="0603" pcbX={8} pcbY={0} pcbRotation={90} />
    <trace from=".R1 > .pin1" to="net.V5" />
    <trace from=".R1 > .pin2" to="net.GND" />
    <trace from=".R2 > .pin1" to="net.V5" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".C1 > .pin1" to="net.V5" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
);
