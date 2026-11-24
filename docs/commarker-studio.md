# Prepare a copper PCB for ComMarker Studio

In the board's **Outputs** tab, select **Copper PCB** and choose **Open in ComMarker Studio**. FabDesk uses the saved board revision to generate full-size, front-side removal artwork for pre-cut copper-clad stock. Black regions are the areas to engrave. Pads, tracks and copper pours remain clear. The drill map and perimeter cuts are separate operations.

<img src="validation/commarker-studio/studio-handoff.png" alt="FabDesk Copper PCB controls with the 150 mm lens and 35 µm foil selected" width="300">

On Windows and macOS, FabDesk opens Studio and copies the local SVG path, including when the project is on a remote FabDesk core. If prompted, locate your copy of Studio. In Studio, choose **Create → Vector** and paste the path. In a Mac file picker, press **⌘⇧G** first. **Copy SVG path** restores the path to the clipboard without re-exporting. The browser client downloads the same SVG.

Keep the import at 1:1. Select the whole graphic and compare its width and height with the expected graphic size in FabDesk. When copper reaches an entire edge, the engraved shape can be smaller than the board. FabDesk also shows its offset from the board's top-left corner for alignment. Select the artwork, enable **Fill**, and check that the preview leaves the pads and tracks clear. [Studio vector and fill controls](https://blog.commarker.com/archives/55321)

## Connect Studio to the Omni X

For a stock machine, connect the Windows PC or Mac to the Omni X by **USB**. At the first connection, follow Studio’s prompt to load the parameters from the machine and restart Studio. Check that Studio shows **Connected**. Under **Laser Device → Field Lens**, select **B** for the installed 150 × 150 mm lens or **A** for the 70 × 70 mm lens. The lens selector in FabDesk identifies your material preset. Studio controls the machine’s field calibration. [ComMarker desktop setup](https://blog.commarker.com/archives/55321) · [Omni X user manual, printed pp. 12–16](https://commarker.com/dist/js/uploads/Machines/OmniSeries/OmniX/Manual/OmniXUserManual.pdf)

ComMarker documents the Omni X’s **Wi-Fi** connection for its mobile app. Its Windows and macOS instructions use USB. Direct job transfer over Wi-Fi from FabDesk remains unverified. [Omni X specifications](https://commarker.com/omni-x-uv-laser-engraver/spec) · [ComMarker mobile pairing](https://blog.commarker.com/archives/55493)

For custom software, ComMarker offers an SDK for evaluation by request. Its published service costs US$1,000 per machine and includes installation of a BSL DBK21B USB controller. With that configuration, the Omni loses autofocus, electronic lifting, glass internal engraving and relief engraving. [ComMarker SDK integration terms](https://support.commarker.com/hc/en-us/articles/63061519589401-ComMarker-SDK-Integration-Services-FAQ)

## Set up a reusable Omni X 6W material

In **Omni X setup**, confirm the lens and foil thickness. The initial selection is a **150 mm lens and 35 µm copper**. Choose **Open test coupon** to check Studio import independently of the active design. The sample should measure 20 × 12 mm and display two clear traces connecting four round pads when Fill is enabled.

FabDesk remembers your Studio Material Library name and your tested settings notes for that lens and foil. Select the imported artwork, open the **Library** control in Studio's **Laser Settings**, choose the matching material, and check the Fill interval. The SVG carries the board geometry. Studio applies the laser parameters.

For new stock, use **Array → Material Test Array** on a scrap of the same laminate. Inspect for copper left in the gaps and damage to the substrate. For a board test, import the [20 × 12 mm coupon artwork](examples/omni-x-copper-coupon-remove.svg) or open its [KiCad board](examples/omni-x-copper-coupon.kicad_pcb) in FabDesk. Verify continuity from TP1 to TP2 and from TP3 to TP4, and an open circuit from TP1 to TP3. Once a combination passes, save it in Studio's material library under a name that identifies the lens and stock. Select that entry on subsequent imports. [ComMarker material test procedure](https://commarker.com/dist/js/uploads/Machines/OmniSeries/OmniX/Manual/OmniXOperationTutorial.pdf)

ComMarker's Omni X 6W tables provide **PCB Marking** entries for the 70 mm and 150 mm lenses. They give no copper thickness or electrical isolation result. ComMarker's separate direct-ablation example uses a **12W** UV laser on 18 µm and 35 µm foil. These references do not establish a 6W removal preset. [Omni X 6W material tables](https://commarker.com/dist/js/uploads/Machines/OmniSeries/OmniX/MaterialSettings/Omni%20X%206W%20Material%20Settings.pdf) · [ComMarker copper-clad PCB experiments](https://blog.commarker.com/archives/59265)
