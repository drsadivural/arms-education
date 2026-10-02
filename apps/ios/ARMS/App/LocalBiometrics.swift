import ARMSKit
import Foundation
import LocalAuthentication

/// Face ID / Touch ID through LocalAuthentication (biometrics only: the device passcode is not accepted, the
/// fallback button leads to the ARMS password instead). Requires `NSFaceIDUsageDescription` in Info.plist.
final class LocalBiometrics: BiometricAuthenticator, @unchecked Sendable {
  func availability() async -> BiometricAvailability {
    let context = LAContext()
    var error: NSError?
    let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    guard let kind = Self.kind(context.biometryType) else { return .unavailable }
    if canEvaluate { return .available(kind) }
    if let code = error.map({ LAError.Code(rawValue: $0.code) }) ?? nil,
      code == .biometryNotEnrolled || code == .biometryNotAvailable
    {
      return .notEnrolled(kind)
    }
    return .unavailable
  }

  func authenticate(reason: String) async -> BiometricResult {
    let context = LAContext()
    context.localizedFallbackTitle = "パスワードでログイン"
    context.localizedCancelTitle = "キャンセル"
    do {
      let ok = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
      return ok ? .success : .failed
    } catch let error as LAError {
      switch error.code {
      case .userCancel, .appCancel, .systemCancel: return .cancelled
      case .userFallback: return .fallbackToPassword
      case .biometryLockout: return .lockedOut
      case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet: return .unavailable
      default: return .failed
      }
    } catch {
      return .failed
    }
  }

  func enrollmentState() async -> Data? {
    let context = LAContext()
    var error: NSError?
    _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    return context.evaluatedPolicyDomainState
  }

  private static func kind(_ type: LABiometryType) -> BiometryKind? {
    switch type {
    case .faceID: return .faceID
    case .touchID: return .touchID
    case .opticID: return .opticID
    case .none: return nil
    @unknown default: return nil
    }
  }
}
