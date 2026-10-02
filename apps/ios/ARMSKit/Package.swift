// swift-tools-version:6.0
// ARMSKit — platform-independent core of the ARMS iOS app (DTOs, API client, formatting,
// business rules, view models and the OpenAI Realtime tool bridge). It builds and is tested
// on Linux with `swift test`; the SwiftUI app target (apps/ios/ARMS) links it on iOS.
import PackageDescription

let package = Package(
  name: "ARMSKit",
  defaultLocalization: "ja",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "ARMSKit", targets: ["ARMSKit"])
  ],
  targets: [
    .target(name: "ARMSKit"),
    // Linux-only link support for test executables. Some Linux Swift toolchain packages ship a
    // libswiftObservation.so with an unresolved `swift::threading::fatal` symbol, which makes any
    // executable that uses the Observation framework fail to link. This tiny C++ target provides
    // that symbol (print + abort, identical semantics) and is only linked into the Linux test
    // bundle. It is never part of the iOS app.
    .target(name: "ARMSKitLinuxSupport"),
    .testTarget(
      name: "ARMSKitTests",
      dependencies: [
        "ARMSKit",
        .target(name: "ARMSKitLinuxSupport", condition: .when(platforms: [.linux])),
      ]
    ),
  ],
  cxxLanguageStandard: .cxx17
)
