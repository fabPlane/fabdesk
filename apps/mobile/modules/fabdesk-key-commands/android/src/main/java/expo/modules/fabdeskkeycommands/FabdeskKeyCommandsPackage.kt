package expo.modules.fabdeskkeycommands

import android.content.Context
import android.view.KeyEvent
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler

/** Hooks the activity's `onKeyDown` (via `ReactActivityDelegateWrapper`) into the registry. */
class FabdeskKeyCommandsPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context?): List<ReactActivityHandler> {
    return listOf(
      object : ReactActivityHandler {
        override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
          return FabdeskKeyCommandRegistry.handle(keyCode, event)
        }
      }
    )
  }
}
