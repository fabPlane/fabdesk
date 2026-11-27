# ComMarker Studio project and preset verification

ComMarker Studio 1.0.41 for Windows x64 reopened a native `.orzr` made by FabDesk and retained the selected pen and Fill settings. The test on November 24, 2026 used the document reader behind Studio’s **File → Open** and its **Save As** writer. The laser stayed offline.

## Material round trip

1. Create an editable coupon with a single active Fill in the stock document engine. Give pen 7 distinctive test values and use Studio’s own serializer for the per-shape pen settings. Save the calibration document using Studio’s ordinary project encoding, format 1.
2. Pass those bytes and FabDesk’s 20 × 12 mm copper-removal SVG to the production TypeScript project writer. Open the resulting format-0 project with Studio’s document manager, save a copy, and compare the reopened material record with the original.
3. Check the geometry, material table and graphic properties independently. The reopened file contained one editable polyline with three closed contours, centered at (0, 0). Pen 7 occupied table slot 7. All selected pen fields, the three Fill layer records and the eight per-shape laser settings matched the calibration file. The generated shape had an identity transform and a disabled array. The document had no external data sources.

Studio also uses a pen’s position in the table. A test placing a record labeled “7” at slot 0 left Studio’s default entry at slot 7. FabDesk writes complete, disabled entries before a nonzero selected index. This preserves the selected index without bringing unrelated template materials into the new job.

## macOS round trip

The stock Intel Mac editor in ComMarker Studio 1.0.42 opened FabDesk’s 20 × 12 mm coupon on a macOS 15 GitHub runner. Studio saved an inspectable copy and an ordinary format-1 project. The copy retained all three closed contours, the centered bounds and every coordinate within 0.0000000001 mm. The complete selected pen at slot 3, per-shape settings, all three Fill layers, both transforms and the array settings matched. FabDesk imported the ordinary Mac save as a template and reproduced the coupon and its material. The test exercised Studio’s document APIs without attaching a device. [Mac run and verification log](https://github.com/fabPlane/fabdesk/actions/runs/45387610457/job/138422551363)

The opt-in workflow downloads the vendor’s Intel disk image and checks SHA-256 `91fac19e7b53d82500cd8133fa0eaf14c1a34136f8c2dee93e514e544bda22c6`. The native harness is compiled only on the validation runner. [Verification workflow](../../../.github/workflows/commarker-studio-native.yml)

## Copper geometry

The two-net coupon, an inset board with a copper ring and a cutout, and a routed 16.5 × 40 mm StickHub board were compared with Studio’s own SVG import. Across the three fixtures, 8,514 native hatch points matched within 0.000001 mm after aligning the coordinate origins. The inset board retained its margins, and the hatch left the coupon pads and trace centres clear. The 0.1 mm spacing in this software test was chosen for measuring geometry. [Fixture dimensions, probes and plotted hatches](native-import.md)

## Scope

The project reader accepts the two verified encodings of Studio’s `2.1.8595` document schema. A source template must have one filled vector and one consistent pen across its active Fill layers. FabDesk accepts ordinary saves from the tested Windows and Mac editors. The production writer runs in TypeScript and requires no vendor libraries.

These checks cover file interoperability and copper geometry. Physical clearance, insulation resistance, substrate damage and registration on an Omni X 6W with a 150 mm lens and 35 µm foil require a coupon on that machine. The software fixtures contain synthetic test values. The Windows test did not operate the engraver.

| Verified Windows component | SHA-256 |
| --- | --- |
| ComMarker Studio executable | `cc4e1656eba20a5b041fd923bd09f5a12fb2e5484ca0dc3072048dc90847a9cb` |
| Studio document and material bridge (`lcsDI.dll`) | `a7f59293c3c25db44f39148080357ad945c15c4f3e47aa6cb4d47d27d82c2466` |
