export const PCB_FROM = `(kicad_pcb
  (version 20241201)
  (generator "test")
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 10 20 0)
    (property "Reference" "R1" (at 10 18 0))
    (property "Value" "10k" (at 10 22 0))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 2 "VCC"))
  )
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 30 20 0)
    (property "Reference" "R2" (at 30 18 0))
    (property "Value" "1k" (at 30 22 0))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 2 "VCC"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 1 "GND"))
  )
  (segment (start 10.8 20) (end 29.2 20) (width 0.25) (layer "F.Cu") (net 2))
  (gr_rect (start 0 0) (end 50 40) (stroke (width 0.1)) (layer "Edge.Cuts"))
)
`;

export const PCB_TO = `(kicad_pcb
  (version 20241201)
  (generator "test")
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (net 3 "N_NEW")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 12 24 90)
    (property "Reference" "R1" (at 12 22 0))
    (property "Value" "4k7" (at 12 26 0))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 3 "N_NEW"))
  )
  (footprint "Capacitor_SMD:C_0603_1608Metric"
    (layer "F.Cu")
    (transform (translate 40 18) (rotate 0) (scale 1 1))
    (property "Reference" "C1" (at 40 16 0))
    (property "Value" "100n" (at 40 20 0))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 3 "N_NEW"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu") (net 2 "VCC"))
  )
  (segment (start 12.8 24) (end 39.2 18) (width 0.25) (layer "F.Cu") (net 3))
  (gr_rect (start 0 0) (end 50 40) (stroke (width 0.1)) (layer "Edge.Cuts"))
)
`;

export const SCH_FROM = `(kicad_sch
  (version 20231120)
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R")
      (property "Value" "R")
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 50.8 38.1 0)
    (property "Reference" "R1" (at 50.8 36 0))
    (property "Value" "10k" (at 50.8 40 0))
  )
  (symbol
    (lib_id "Device:R")
    (at 70 38.1 0)
    (property "Reference" "R2" (at 70 36 0))
    (property "Value" "1k" (at 70 40 0))
  )
  (wire (pts (xy 50.8 38.1) (xy 70 38.1)))
  (label "VCC" (at 60 38.1 0))
)
`;

export const SCH_TO = `(kicad_sch
  (version 20231120)
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R")
      (property "Value" "R")
    )
    (symbol "Device:C"
      (property "Reference" "C")
      (property "Value" "C")
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 50.8 38.1 0)
    (property "Reference" "R1" (at 50.8 36 0))
    (property "Value" "4k7" (at 50.8 40 0))
  )
  (symbol
    (lib_id "Device:C")
    (at 90 40 0)
    (property "Reference" "C1" (at 90 38 0))
    (property "Value" "100n" (at 90 42 0))
  )
  (wire (pts (xy 50.8 38.1) (xy 90 40)))
  (global_label "N_NEW" (at 70 39 0))
)
`;

export const NETLIST_FROM = {
  netlist: {
    components: [
      { ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" },
      { ref: "R2", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric" },
    ],
    nets: [
      { name: "GND", nodes: [{ ref: "R1", pin: "1" }, { ref: "R2", pin: "2" }] },
      { name: "VCC", nodes: [{ ref: "R1", pin: "2" }, { ref: "R2", pin: "1" }] },
    ],
  },
};

export const NETLIST_TO = {
  netlist: {
    components: [
      { ref: "R1", value: "4k7", footprint: "Resistor_SMD:R_0603_1608Metric" },
      { ref: "C1", value: "100n", footprint: "Capacitor_SMD:C_0603_1608Metric" },
    ],
    nets: [
      { name: "GND", nodes: [{ ref: "R1", pin: "1" }] },
      { name: "VCC", nodes: [{ ref: "C1", pin: "2" }] },
      { name: "N_NEW", nodes: [{ ref: "R1", pin: "2" }, { ref: "C1", pin: "1" }] },
    ],
  },
};
