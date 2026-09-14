package expo.modules.fabdeskbackgroundgrace

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Android keeps the JS thread running in the background; nothing to do here. */
class FabdeskBackgroundGraceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FabdeskBackgroundGrace")
  }
}
