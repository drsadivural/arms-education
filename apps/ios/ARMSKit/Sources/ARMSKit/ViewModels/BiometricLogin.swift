import Foundation

/// The kind of biometrics the device offers.
public enum BiometryKind: String, Sendable, Equatable {
  case faceID
  case touchID
  case opticID

  /// Japanese UI label (product names stay in English as Apple uses them in Japan).
  public var labelJa: String {
    switch self {
    case .faceID: return "Face ID"
    case .touchID: return "Touch ID"
    case .opticID: return "Optic ID"
    }
  }

  /// SF Symbol for buttons.
  public var systemImage: String {
    switch self {
    case .faceID: return "faceid"
    case .touchID: return "touchid"
    case .opticID: return "opticid"
    }
  }
}

public enum BiometricAvailability: Sendable, Equatable {
  /// Biometrics can be used now.
  case available(BiometryKind)
  /// The hardware exists but nothing is enrolled (or it is turned off for the app in iOS Settings).
  case notEnrolled(BiometryKind)
  /// No biometric hardware, or no device passcode.
  case unavailable

  public var kind: BiometryKind? {
    switch self {
    case .available(let k), .notEnrolled(let k): return k
    case .unavailable: return nil
    }
  }
}

public enum BiometricResult: Sendable, Equatable {
  case success
  /// The person cancelled (or the system interrupted); nothing changes.
  case cancelled
  /// The person chose 「パスワードでログイン」.
  case fallbackToPassword
  /// Too many failed attempts: iOS requires the device passcode before biometrics work again.
  case lockedOut
  /// Biometrics became unavailable (turned off, not enrolled, no passcode).
  case unavailable
  case failed
}

/// Biometric check (implemented with LocalAuthentication in the app; a fake in tests).
public protocol BiometricAuthenticator: Sendable {
  func availability() async -> BiometricAvailability
  /// Runs the system Face ID / Touch ID prompt with the given Japanese reason.
  func authenticate(reason: String) async -> BiometricResult
  /// Opaque value of the currently enrolled biometrics (`LAContext.evaluatedPolicyDomainState`). It changes when a
  /// face or finger is added or removed, which turns biometric login off (someone else may have enrolled).
  func enrollmentState() async -> Data?
}

extension StorageKeys {
  /// User id for which biometric login is on (cleared on every sign-out).
  public static let biometricLoginUserId = "arms.biometricLogin.userId"
  /// Base64 of the enrollment state captured when biometric login was turned on.
  public static let biometricLoginEnrollment = "arms.biometricLogin.enrollment"
  /// User id that answered 「今はしない」 to the offer after password sign-in.
  public static let biometricLoginDeclinedUserId = "arms.biometricLogin.declinedUserId"
}
