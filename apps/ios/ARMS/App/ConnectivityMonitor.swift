import ARMSKit
import Foundation
import Network

/// Feeds NWPathMonitor reachability into `AppContext.isOnline` (offline = cached data, read-only).
final class ConnectivityMonitor: @unchecked Sendable {
  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "arms.connectivity")

  func start(updating context: AppContext) {
    monitor.pathUpdateHandler = { [weak context] path in
      let online = path.status == .satisfied
      Task { @MainActor in
        guard let context else { return }
        let wasOffline = !context.isOnline
        context.setOnline(online)
        // Coming back online: re-read everything that may have changed meanwhile.
        if online && wasOffline { context.requestRefresh() }
      }
    }
    monitor.start(queue: queue)
  }

  func stop() {
    monitor.cancel()
  }
}
