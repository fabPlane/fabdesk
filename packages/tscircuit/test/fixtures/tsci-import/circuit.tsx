import { useRedLed } from "@tsci/seveibar.red-led";

/** Network-gated fixture: pulls a component from the tscircuit registry. */
export default () => {
  const RedLed = useRedLed("LED1");
  return (
    <board width="12mm" height="10mm">
      <RedLed pcbX={0} pcbY={0} />
      <resistor name="R1" resistance="1k" footprint="0402" pcbX={3} pcbY={0} schX={2} />
      <trace from=".R1 > .pin1" to=".LED1 > .anode" />
    </board>
  );
};
