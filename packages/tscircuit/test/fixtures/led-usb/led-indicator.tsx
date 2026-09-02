export const LedIndicator = (props: { name: string; resistorName: string }) => (
  <group>
    <resistor name={props.resistorName} resistance="330" footprint="0603" pcbX={0} pcbY={3} schX={0} schY={1} />
    <led name={props.name} color="red" footprint="0603" pcbX={0} pcbY={-3} schX={0} schY={-1} />
    <trace from={`.${props.resistorName} > .pin2`} to={`.${props.name} > .anode`} />
  </group>
);
