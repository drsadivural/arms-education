import ARMSKit
import AVFAudio
import Foundation

/// `AVAudioSession` for the voice assistant: `.playAndRecord` + `.voiceChat` (echo cancellation),
/// Bluetooth (HFP for AirPods microphones, A2DP output) and the speaker by default.
/// Interruptions (phone calls, Siri) and media-service resets end the session; route changes
/// (AirPods connected/removed) are reported for the UI. No background audio mode is used.
final class AudioSessionManager: VoiceAudioSession, @unchecked Sendable {
  static let categoryOptions: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]

  private let lock = NSLock()
  private var handler: (@Sendable (AudioSessionEvent) -> Void)?
  private var observers: [NSObjectProtocol] = []

  init() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) {
        [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        self?.emit(type == .began ? .interruptionBegan : .interruptionEnded)
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] _ in
        guard let self else { return }
        self.emit(.routeChanged(routeName: self.currentRouteName))
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) {
        [weak self] _ in
        self?.emit(.mediaServicesReset)
      })
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  static func currentPermission() -> MicrophonePermission {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return .granted
    case .denied: return .denied
    case .undetermined: return .undetermined
    @unknown default: return .undetermined
    }
  }

  func microphonePermission() -> MicrophonePermission { Self.currentPermission() }

  func requestMicrophonePermission() async -> Bool {
    await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { granted in
        continuation.resume(returning: granted)
      }
    }
  }

  func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.categoryOptions)
    try session.setActive(true)
  }

  func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  func setEventHandler(_ handler: (@Sendable (AudioSessionEvent) -> Void)?) {
    lock.lock()
    self.handler = handler
    lock.unlock()
  }

  var currentRouteName: String {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    return outputs.first?.portName ?? ""
  }

  private func emit(_ event: AudioSessionEvent) {
    lock.lock()
    let handler = self.handler
    lock.unlock()
    handler?(event)
  }
}
