import SwiftUI
import UIKit
import XCTest

@testable import ARMS

final class AppConfigurationTests: XCTestCase {
  func testLoadsValidConfigurationAndAppendsAPIPath() throws {
    let info: [String: Any] = [
      "ARMSAPIBaseURL": "https://arms-api.example.com",
      "ARMSSupabaseURL": "https://project.supabase.co",
      "ARMSSupabasePublishableKey": "sb_publishable_test",
      "ARMSTermsURL": "https://example.com/terms",
      "ARMSPrivacyPolicyURL": "$(PRIVACY_POLICY_URL)",
      "ARMSAPNsEnvironment": "production",
    ]
    let config = try AppConfiguration.load(from: info).get()
    XCTAssertEqual(config.apiBaseURL.absoluteString, "https://arms-api.example.com/api/v1")
    XCTAssertEqual(config.supabaseURL.host, "project.supabase.co")
    XCTAssertEqual(config.termsURL?.absoluteString, "https://example.com/terms")
    XCTAssertNil(config.privacyPolicyURL, "unresolved build settings are treated as missing")
    XCTAssertEqual(config.apnsEnvironment, .production)
  }

  func testMissingAndInvalidValues() {
    XCTAssertEqual(
      AppConfiguration.load(from: ["ARMSAPIBaseURL": "", "ARMSSupabaseURL": "$(SUPABASE_URL)"]),
      .failure(.missing(["API_BASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"])))
    XCTAssertEqual(
      AppConfiguration.load(from: [
        "ARMSAPIBaseURL": "http://arms.example.com", "ARMSSupabaseURL": "https://p.supabase.co",
        "ARMSSupabasePublishableKey": "k",
      ]),
      .failure(.invalid(["API_BASE_URL"])), "plain HTTP is only allowed for localhost")
    XCTAssertNotNil(AppConfiguration.validatedURL("http://localhost:8787"))
    XCTAssertEqual(
      AppConfiguration.withAPIPath(URL(string: "https://x.example.com/custom/v1")!).absoluteString,
      "https://x.example.com/custom/v1")
  }

  func testSupabaseAuthURL() {
    XCTAssertEqual(
      SupabaseAuthService.authURL(URL(string: "https://p.supabase.co")!).absoluteString, "https://p.supabase.co/auth/v1")
    XCTAssertEqual(
      SupabaseAuthService.authURL(URL(string: "http://localhost:54321/auth/v1")!).absoluteString,
      "http://localhost:54321/auth/v1")
  }
}

@MainActor
final class RouterTests: XCTestCase {
  func testDeepLinksSelectTabAndPath() {
    let router = Router()
    router.open(.reservation(id: "66666666-6666-4666-8666-666666666666"), role: .student)
    XCTAssertEqual(router.tab, .booking)
    XCTAssertEqual(router.bookingPath, [.reservation(id: "66666666-6666-4666-8666-666666666666")])
    router.open(.todayLessons, role: .teacher)
    XCTAssertEqual(router.tab, .home)
    XCTAssertEqual(router.homePath, [.todayLessons])
    router.open(.reservations, role: .student)
    XCTAssertEqual(router.bookingSegment, .mine)
    router.open(.notifications, role: .student)
    XCTAssertEqual(router.homePath, [.notifications])
    router.reset()
    XCTAssertEqual(router.tab, .home)
    XCTAssertTrue(router.homePath.isEmpty && router.bookingPath.isEmpty)
  }

  func testPushUsesSelectedTab() {
    let router = Router()
    router.tab = .progress
    router.push(.studentDetail(id: "s1"))
    XCTAssertEqual(router.progressPath, [.studentDetail(id: "s1")])
    router.popToRoot()
    XCTAssertTrue(router.progressPath.isEmpty)
  }
}

final class DesignSystemTests: XCTestCase {
  func testHexColorComponents() {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    UIColor(hex: 0x0076D1).getRed(&r, green: &g, blue: &b, alpha: &a)
    XCTAssertEqual(r, 0, accuracy: 0.001)
    XCTAssertEqual(g, 118.0 / 255, accuracy: 0.001)
    XCTAssertEqual(b, 209.0 / 255, accuracy: 0.001)
  }

  func testThemeMapsToColorScheme() {
    XCTAssertEqual(ThemePreference.light.colorScheme, .light)
    XCTAssertEqual(ThemePreference.dark.colorScheme, .dark)
    XCTAssertNil(ThemePreference.system.colorScheme)
  }

  func testMaterialFileExtensions() {
    XCTAssertEqual(MaterialFiles.fileExtension(contentType: "application/pdf", kind: .pdf), "pdf")
    XCTAssertEqual(MaterialFiles.fileExtension(contentType: "image/jpeg; charset=binary", kind: .image), "jpg")
    XCTAssertEqual(MaterialFiles.fileExtension(contentType: "application/octet-stream", kind: .pdf), "pdf")
  }

  func testBundledResources() {
    XCTAssertNotNil(UIImage(named: "BrandLogo", in: Bundle(for: AppDelegate.self), with: nil), "H&A logo asset is bundled")
    XCTAssertEqual(
      Bundle(for: AppDelegate.self).object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String,
      "予約や研修内容を日本語で音声操作するためにマイクを使用します。")
    XCTAssertNotNil(Bundle(for: AppDelegate.self).url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
  }
}
