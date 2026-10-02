import Foundation
import XCTest

@testable import ARMSKit

final class FakeBiometrics: BiometricAuthenticator, @unchecked Sendable {
  private let lock = NSLock()
  var availabilityValue: BiometricAvailability = .available(.faceID)
  var results: [BiometricResult] = []
  var enrollment: Data? = Data("faces-v1".utf8)
  var prompts: [String] = []

  func availability() async -> BiometricAvailability { lock.withLock { availabilityValue } }
  func authenticate(reason: String) async -> BiometricResult {
    lock.withLock {
      prompts.append(reason)
      return results.isEmpty ? .success : results.removeFirst()
    }
  }
  func enrollmentState() async -> Data? { lock.withLock { enrollment } }
}

@MainActor
final class BiometricLoginTests: XCTestCase {
  private func makeStore(_ t: MockTransport, tokens: StubTokens, keyValues: InMemoryKeyValueStore, biometrics: FakeBiometrics)
    -> SessionStore
  {
    let context = makeContext(t, me: nil, tokens: tokens, cache: InMemoryResponseCache(), keyValues: keyValues)
    let store = SessionStore(auth: tokens, context: context, biometrics: biometrics)
    store.selectedRole = .student
    return store
  }

  /// Signs in with the password and accepts the Face ID offer.
  private func enableAfterPasswordSignIn(_ store: SessionStore) async {
    await store.signIn(email: "wada@example.invalid", password: "pw")
    XCTAssertTrue(store.offerBiometricLogin, "offered after a password sign-in")
    let enabled = await store.setBiometricLogin(enabled: true)
    XCTAssertTrue(enabled)
    XCTAssertFalse(store.offerBiometricLogin)
  }

  func testRestoreStaysLockedWithoutAnyRequestUntilFaceIDSucceeds() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let tokens = StubTokens()
    tokens.signedIn = false
    let keyValues = InMemoryKeyValueStore()
    let biometrics = FakeBiometrics()
    await enableAfterPasswordSignIn(makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics))
    XCTAssertEqual(keyValues.string(forKey: StorageKeys.biometricLoginUserId), Fixtures.studentId)

    // Next launch: same Keychain session and preferences.
    let relaunched = makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics)
    let before = t.requests.count
    await relaunched.restore()
    XCTAssertEqual(relaunched.state, .locked(.faceID))
    XCTAssertEqual(t.requests.count, before, "nothing is sent before Face ID")

    biometrics.results = [.cancelled]
    await relaunched.unlock()
    XCTAssertEqual(relaunched.state, .locked(.faceID), "cancel keeps the lock")

    biometrics.results = [.failed]
    await relaunched.unlock()
    XCTAssertEqual(relaunched.message, SessionStore.biometricFailedMessage)

    biometrics.results = [.success]
    await relaunched.unlock()
    XCTAssertEqual(relaunched.me?.id, Fixtures.studentId)
    XCTAssertNil(relaunched.message)
    XCTAssertEqual(biometrics.prompts.last, "ARMSにログインします")
  }

  func testPasswordFallbackLockoutAndUnavailableSignOut() async {
    for (result, message) in [
      (BiometricResult.fallbackToPassword, nil as String?), (.lockedOut, SessionStore.biometricLockedOutMessage),
      (.unavailable, SessionStore.biometricUnavailableMessage),
    ] {
      let t = MockTransport()
      t.on(.get, "/me", json: Fixtures.meJSON())
      let tokens = StubTokens()
      let keyValues = InMemoryKeyValueStore()
      let biometrics = FakeBiometrics()
      await enableAfterPasswordSignIn(makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics))
      let relaunched = makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics)
      await relaunched.restore()
      biometrics.results = [result]
      await relaunched.unlock()
      XCTAssertEqual(relaunched.state, .signedOut, "\(result)")
      XCTAssertEqual(relaunched.message, message)
      XCTAssertFalse(relaunched.isBiometricLoginEnabled, "sign-out turns biometric login off")
      XCTAssertEqual(tokens.signedIn, false)
    }
  }

  func testChangedEnrollmentOrUnavailableBiometricsRequireThePassword() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let tokens = StubTokens()
    let keyValues = InMemoryKeyValueStore()
    let biometrics = FakeBiometrics()
    await enableAfterPasswordSignIn(makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics))
    biometrics.enrollment = Data("faces-v2".utf8)  // someone added a face
    let relaunched = makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics)
    await relaunched.restore()
    XCTAssertEqual(relaunched.state, .signedOut)
    XCTAssertEqual(relaunched.message, SessionStore.biometricChangedMessage)
    XCTAssertFalse(relaunched.isBiometricLoginEnabled)

    let tokens2 = StubTokens()
    let keyValues2 = InMemoryKeyValueStore()
    let biometrics2 = FakeBiometrics()
    await enableAfterPasswordSignIn(makeStore(t, tokens: tokens2, keyValues: keyValues2, biometrics: biometrics2))
    biometrics2.availabilityValue = .notEnrolled(.faceID)  // Face ID turned off for the app
    let again = makeStore(t, tokens: tokens2, keyValues: keyValues2, biometrics: biometrics2)
    await again.restore()
    XCTAssertEqual(again.state, .signedOut)
    XCTAssertEqual(again.message, SessionStore.biometricUnavailableMessage)
  }

  func testOfferRespectsDeclineAndAvailabilityAndSettingsToggle() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let tokens = StubTokens()
    let keyValues = InMemoryKeyValueStore()
    let biometrics = FakeBiometrics()
    let store = makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics)
    await store.signIn(email: "wada@example.invalid", password: "pw")
    XCTAssertTrue(store.offerBiometricLogin)
    store.declineBiometricLogin()
    await store.signOut()
    await store.signIn(email: "wada@example.invalid", password: "pw")
    XCTAssertFalse(store.offerBiometricLogin, "not offered again after 「今はしない」")

    // 設定 toggle: a failed check does not turn it on; a successful one does; off clears it.
    biometrics.results = [.cancelled]
    let failed = await store.setBiometricLogin(enabled: true)
    XCTAssertFalse(failed)
    XCTAssertFalse(store.isBiometricLoginEnabled)
    let enabled = await store.setBiometricLogin(enabled: true)
    XCTAssertTrue(enabled)
    XCTAssertTrue(store.isBiometricLoginEnabled)
    XCTAssertEqual(biometrics.prompts.last, "Face IDでのログインを有効にします")
    await store.setBiometricLogin(enabled: false)
    XCTAssertFalse(store.isBiometricLoginEnabled)

    let noHardware = FakeBiometrics()
    noHardware.availabilityValue = .unavailable
    let other = makeStore(t, tokens: StubTokens(), keyValues: InMemoryKeyValueStore(), biometrics: noHardware)
    await other.signIn(email: "wada@example.invalid", password: "pw")
    XCTAssertFalse(other.offerBiometricLogin, "no offer without biometrics")
  }

  func testRelocksAfterFiveMinutesInTheBackground() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let tokens = StubTokens()
    let keyValues = InMemoryKeyValueStore()
    let biometrics = FakeBiometrics()
    let store = makeStore(t, tokens: tokens, keyValues: keyValues, biometrics: biometrics)
    await store.signIn(email: "wada@example.invalid", password: "pw")
    store.lockAfterBackground(seconds: 600)
    XCTAssertNotNil(store.me, "not enabled → never locks")
    await store.setBiometricLogin(enabled: true)
    store.lockAfterBackground(seconds: 60)
    XCTAssertNotNil(store.me, "short trips to the background do not lock")
    store.lockAfterBackground(seconds: 301)
    XCTAssertEqual(store.state, .locked(.faceID))
    await store.unlock()
    XCTAssertEqual(store.me?.id, Fixtures.studentId)
  }
}
