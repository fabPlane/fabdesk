import ExpoModulesCore
import UIKit

let onKeyCommand = "onKeyCommand"

/**
 * Registers `UIKeyCommand`s for the combos JS asks for and reports presses back as events.
 *
 * The commands hang off the window's root view controller, which sits in the responder chain of
 * everything the app draws (react-native-screens pushes are child controllers of it), and the
 * action selector is an extension on `UIResponder` so whichever responder UIKit targets — a
 * focused text view or the root controller itself — hands the press to the registry.
 */
public final class FabdeskKeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FabdeskKeyCommands")

    Events(onKeyCommand)

    Function("setCommands") { (ids: [String]) in
      DispatchQueue.main.async {
        FabdeskKeyCommandRegistry.shared.setCommands(ids)
      }
    }

    OnStartObserving(onKeyCommand) {
      FabdeskKeyCommandRegistry.shared.onCommand = { [weak self] id in
        self?.sendEvent(onKeyCommand, ["id": id])
      }
    }

    OnStopObserving(onKeyCommand) {
      FabdeskKeyCommandRegistry.shared.onCommand = nil
    }
  }
}

final class FabdeskKeyCommandRegistry {
  static let shared = FabdeskKeyCommandRegistry()

  var onCommand: ((String) -> Void)?
  private var installed: [UIKeyCommand] = []
  private weak var host: UIViewController?

  func setCommands(_ ids: [String]) {
    if let previous = host {
      for command in installed {
        previous.removeKeyCommand(command)
      }
    }
    installed = []
    guard let root = Self.rootViewController() else {
      return
    }
    host = root
    installed = ids.compactMap { Self.makeCommand($0) }
    for command in installed {
      root.addKeyCommand(command)
    }
  }

  func dispatch(_ command: UIKeyCommand) {
    guard let id = command.propertyList as? String else {
      return
    }
    onCommand?(id)
  }

  /// Mirrors `parseCombo` in `src/lib/key-combo.ts`: ids arrive canonical, so no aliasing here.
  private static func makeCommand(_ id: String) -> UIKeyCommand? {
    var flags: UIKeyModifierFlags = []
    var input: String?
    for part in id.split(separator: "+").map({ String($0) }) {
      switch part {
      case "cmd":
        flags.insert(.command)
      case "ctrl":
        flags.insert(.control)
      case "alt":
        flags.insert(.alternate)
      case "shift":
        flags.insert(.shift)
      case "enter":
        input = "\r"
      case "escape":
        input = UIKeyCommand.inputEscape
      case "tab":
        input = "\t"
      case "space":
        input = " "
      case "backspace":
        input = "\u{8}"
      case "delete":
        input = "\u{7F}"
      case "up":
        input = UIKeyCommand.inputUpArrow
      case "down":
        input = UIKeyCommand.inputDownArrow
      case "left":
        input = UIKeyCommand.inputLeftArrow
      case "right":
        input = UIKeyCommand.inputRightArrow
      default:
        input = part
      }
    }
    guard let key = input else {
      return nil
    }
    // `propertyList` is read-only after init; the long initializer is the only way to set it.
    let command = UIKeyCommand(
      title: "",
      image: nil,
      action: #selector(UIResponder.fabdeskHandleKeyCommand(_:)),
      input: key,
      modifierFlags: flags,
      propertyList: id
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return command
  }

  private static func rootViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    let window = windows.first { $0.isKeyWindow } ?? windows.first
    return window?.rootViewController
  }
}

extension UIResponder {
  @objc func fabdeskHandleKeyCommand(_ command: UIKeyCommand) {
    FabdeskKeyCommandRegistry.shared.dispatch(command)
  }
}
