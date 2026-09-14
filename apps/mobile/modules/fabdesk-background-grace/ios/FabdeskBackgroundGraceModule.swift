import ExpoModulesCore
import UIKit

/// Holds a background task from `didEnterBackground` until `willEnterForeground` or the budget
/// expires, so the JS runtime — and its WebSocket to the daemon — keep running long enough to
/// see a run finish and schedule the local notification for it.
public final class FabdeskBackgroundGraceModule: Module {
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("FabdeskBackgroundGrace")

    OnCreate {
      let center = NotificationCenter.default
      self.observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.begin()
      })
      self.observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.end()
      })
    }

    OnDestroy {
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers.removeAll()
      self.end()
    }
  }

  private func begin() {
    guard task == .invalid else { return }
    task = UIApplication.shared.beginBackgroundTask(withName: "fabdesk.grace") { [weak self] in
      // iOS is about to suspend us regardless; release the task cleanly.
      self?.end()
    }
  }

  private func end() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}
