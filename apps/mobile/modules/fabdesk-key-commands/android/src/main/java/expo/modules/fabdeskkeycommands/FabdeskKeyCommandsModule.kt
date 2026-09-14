package expo.modules.fabdeskkeycommands

import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * The JS-facing half: takes the list of combos to listen for and emits `onKeyCommand` with the
 * combo id when one is pressed. Presses arrive through [FabdeskKeyCommandsPackage], which hooks
 * the activity's `onKeyDown`.
 */
class FabdeskKeyCommandsModule : Module() {
  private var observer: ((String) -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("FabdeskKeyCommands")

    Events("onKeyCommand")

    Function("setCommands") { ids: List<String> ->
      FabdeskKeyCommandRegistry.setCommands(ids)
    }

    OnStartObserving("onKeyCommand") {
      val weakModule = WeakReference(this@FabdeskKeyCommandsModule)
      val callback: (String) -> Unit = { id ->
        weakModule.get()?.sendEvent("onKeyCommand", mapOf("id" to id))
      }
      observer = callback
      FabdeskKeyCommandRegistry.observers.add(callback)
    }

    OnStopObserving("onKeyCommand") {
      observer?.let { FabdeskKeyCommandRegistry.observers.remove(it) }
      observer = null
    }
  }
}

object FabdeskKeyCommandRegistry {
  data class Command(val id: String, val keyCode: Int, val ctrl: Boolean, val alt: Boolean, val shift: Boolean)

  @Volatile
  private var commands: List<Command> = emptyList()
  val observers: MutableSet<(String) -> Unit> = mutableSetOf()

  fun setCommands(ids: List<String>) {
    commands = ids.mapNotNull { parse(it) }
  }

  /** True when the press matched a registered combo; the activity then swallows it. */
  fun handle(keyCode: Int, event: KeyEvent?): Boolean {
    val e = event ?: return false
    if (e.repeatCount > 0) return false
    // ⌘ on a Mac keyboard reaches Android as Meta; Ctrl is what Android keyboards have.
    val ctrl = e.isCtrlPressed || e.isMetaPressed
    val match = commands.firstOrNull {
      it.keyCode == keyCode && it.ctrl == ctrl && it.alt == e.isAltPressed && it.shift == e.isShiftPressed
    } ?: return false
    for (observer in observers.toList()) observer(match.id)
    return true
  }

  /** Mirrors `parseCombo` in `src/lib/key-combo.ts`: ids arrive canonical, so no aliasing here. */
  private fun parse(id: String): Command? {
    var ctrl = false
    var alt = false
    var shift = false
    var keyCode: Int? = null
    for (part in id.split("+")) {
      when (part) {
        "cmd", "ctrl" -> ctrl = true
        "alt" -> alt = true
        "shift" -> shift = true
        "enter" -> keyCode = KeyEvent.KEYCODE_ENTER
        "escape" -> keyCode = KeyEvent.KEYCODE_ESCAPE
        "tab" -> keyCode = KeyEvent.KEYCODE_TAB
        "space" -> keyCode = KeyEvent.KEYCODE_SPACE
        "backspace" -> keyCode = KeyEvent.KEYCODE_DEL
        "delete" -> keyCode = KeyEvent.KEYCODE_FORWARD_DEL
        "up" -> keyCode = KeyEvent.KEYCODE_DPAD_UP
        "down" -> keyCode = KeyEvent.KEYCODE_DPAD_DOWN
        "left" -> keyCode = KeyEvent.KEYCODE_DPAD_LEFT
        "right" -> keyCode = KeyEvent.KEYCODE_DPAD_RIGHT
        else -> keyCode = if (part.length == 1) keyCodeFor(part[0]) else null
      }
    }
    val code = keyCode ?: return null
    return Command(id, code, ctrl, alt, shift)
  }

  private fun keyCodeFor(c: Char): Int? = when (c) {
    in 'a'..'z' -> KeyEvent.KEYCODE_A + (c - 'a')
    in '0'..'9' -> KeyEvent.KEYCODE_0 + (c - '0')
    else -> null
  }
}
