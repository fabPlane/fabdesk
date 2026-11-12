/** A small, valid KiCad board (file format 20241229) for the tests that run kicad-cli: two resistors, a header, an outline. */
const fp = (ref: string, x: number, y: number, rot = 0, side: "F" | "B" = "F", extra = "") => {
  const cu = `${side}.Cu`;
  const silk = `${side}.SilkS`;
  const crt = `${side}.CrtYd`;
  const fab = `${side}.Fab`;
  const mask = `${side}.Mask`;
  const paste = `${side}.Paste`;
  return `	(footprint "R_0603_1608Metric"
		(layer "${cu}")
		(uuid "00000000-0000-4000-8000-0000000000${ref.length}${x}")
		(at ${x} ${y} ${rot})
		(property "Reference" "${ref}" (at 0 -1.43 ${rot}) (layer "${silk}") (uuid "10000000-0000-4000-8000-0000000000${ref.length}${x}") (effects (font (size 1 1) (thickness 0.15))))
		(property "Value" "10k" (at 0 1.43 ${rot}) (layer "${fab}") (uuid "20000000-0000-4000-8000-0000000000${ref.length}${x}") (effects (font (size 1 1) (thickness 0.15))))
		(fp_line (start -0.237258 -0.5225) (end 0.237258 -0.5225) (stroke (width 0.12) (type solid)) (layer "${silk}") (uuid "30000000-0000-4000-8000-0000000000${ref.length}${x}"))
		(fp_rect (start -1.48 -0.73) (end 1.48 0.73) (stroke (width 0.05) (type solid)) (fill no) (layer "${crt}") (uuid "40000000-0000-4000-8000-0000000000${ref.length}${x}"))
		(fp_rect (start -0.8 -0.4125) (end 0.8 0.4125) (stroke (width 0.1) (type solid)) (fill no) (layer "${fab}") (uuid "50000000-0000-4000-8000-0000000000${ref.length}${x}"))
		(pad "1" smd roundrect (at -0.825 0 ${rot}) (size 0.8 0.95) (layers "${cu}" "${paste}" "${mask}") (roundrect_rratio 0.25) (net 1 "A") (uuid "60000000-0000-4000-8000-0000000000${ref.length}${x}"))
		(pad "2" smd roundrect (at 0.825 0 ${rot}) (size 0.8 0.95) (layers "${cu}" "${paste}" "${mask}") (roundrect_rratio 0.25) (net 2 "B") (uuid "70000000-0000-4000-8000-0000000000${ref.length}${x}"))
		${extra}
	)
`;
};

export const FIXTURE_BOARD = `(kicad_pcb
	(version 20241229)
	(generator "pcbnew")
	(generator_version "9.0")
	(general (thickness 1.6) (legacy_teardrops no))
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(2 "B.Cu" signal)
		(9 "F.Adhes" user "F.Adhesive")
		(11 "B.Adhes" user "B.Adhesive")
		(13 "F.Paste" user)
		(15 "B.Paste" user)
		(5 "F.SilkS" user "F.Silkscreen")
		(7 "B.SilkS" user "B.Silkscreen")
		(1 "F.Mask" user)
		(3 "B.Mask" user)
		(25 "Edge.Cuts" user)
		(27 "Margin" user)
		(31 "F.CrtYd" user "F.Courtyard")
		(29 "B.CrtYd" user "B.Courtyard")
		(35 "F.Fab" user)
		(33 "B.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0.05)
		(pcbplotparams (layerselection 0x00000000_00000000_55555555_5755f5ff) (plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000) (disableapertmacros no) (usegerberextensions no) (usegerberattributes yes) (usegerberadvancedattributes yes) (creategerberjobfile yes) (dashed_line_dash_ratio 12.000000) (dashed_line_gap_ratio 3.000000) (svgprecision 4) (plotframeref no) (mode 1) (useauxorigin no) (hpglpennumber 1) (hpglpenspeed 20) (hpglpendiameter 15.000000) (pdf_front_fp_property_popups yes) (pdf_back_fp_property_popups yes) (dxfpolygonmode yes) (dxfimperialunits yes) (dxfusepcbnewfont yes) (psnegative no) (psa4output no) (plot_black_and_white yes) (sketchpadsonfab no) (plotpadnumbers no) (hidednponfab no) (sketchdnponfab yes) (crossoutdnponfab yes) (subtractmaskfromsilk no) (outputformat 1) (mirror no) (drillshape 1) (scaleselection 1) (outputdirectory ""))
	)
	(net 0 "")
	(net 1 "A")
	(net 2 "B")
${fp("R1", 10, 10)}${fp("R2", 14, 10, 90)}${fp("R3", 20, 10, 0, "B")}
	(segment (start 9.175 10) (end 3 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "80000000-0000-4000-8000-000000000001"))
	(gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "90000000-0000-4000-8000-000000000001"))
	(gr_text "HELLO" (at 15 16 0) (layer "F.SilkS") (uuid "a0000000-0000-4000-8000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
)
`;
