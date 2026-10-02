import ARMSKit
import SwiftUI
import UIKit

/// Design tokens from docs/10_DESIGN_SYSTEM_JA.md (light / dark).
enum ARMSColor {
  static let primary = dynamic(light: 0x0076D1, dark: 0x0076D1)
  /// Primary used for text/links: lighter in dark mode to keep WCAG AA contrast on #192A42.
  static let primaryText = dynamic(light: 0x0076D1, dark: 0x6CB6FF)
  static let navy = dynamic(light: 0x15365D, dark: 0xEDF4FF)
  static let background = dynamic(light: 0xF4F7FB, dark: 0x101D30)
  static let surface = dynamic(light: 0xFFFFFF, dark: 0x192A42)
  static let surfaceMuted = dynamic(light: 0xEEF2F7, dark: 0x22344F)
  static let text = dynamic(light: 0x16324F, dark: 0xEDF4FF)
  static let muted = dynamic(light: 0x64748B, dark: 0xA9B8CC)
  static let border = dynamic(light: 0xDFE7F1, dark: 0x2B405E)
  static let success = dynamic(light: 0x0B7B61, dark: 0x5FD3AE)
  static let warning = dynamic(light: 0x9A6700, dark: 0xF2C14E)
  static let danger = dynamic(light: 0xC93843, dark: 0xFF8A95)
  static let infoBackground = dynamic(light: 0xEAF3FC, dark: 0x16365A)
  static let onPrimary = Color.white
  /// The H&A logo always sits on a white tile (also in dark mode) so the original stays legible.
  static let logoTile = Color.white

  static func tagForeground(_ tone: StatusTone) -> Color {
    switch tone {
    case .success: return success
    case .warning: return warning
    case .danger: return danger
    case .info: return primaryText
    case .neutral: return muted
    }
  }

  static func tagBackground(_ tone: StatusTone) -> Color {
    switch tone {
    case .success: return dynamic(light: 0xE3F4EE, dark: 0x12382F)
    case .warning: return dynamic(light: 0xFFF4D6, dark: 0x3D3214)
    case .danger: return dynamic(light: 0xFBE7E9, dark: 0x43222A)
    case .info: return dynamic(light: 0xE6F1FB, dark: 0x16365A)
    case .neutral: return dynamic(light: 0xEEF2F7, dark: 0x24364F)
    }
  }

  static func dynamic(light: UInt32, dark: UInt32) -> Color {
    Color(
      uiColor: UIColor { traits in
        UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
      })
  }
}

extension UIColor {
  convenience init(hex: UInt32) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}

enum ARMSMetrics {
  static let cardRadius: CGFloat = 20
  static let controlRadius: CGFloat = 14
  static let gutter: CGFloat = 16
  static let minTapTarget: CGFloat = 44
}

extension ThemePreference {
  /// nil follows the system setting.
  var colorScheme: ColorScheme? {
    switch self {
    case .light: return .light
    case .dark: return .dark
    case .system: return nil
    }
  }
}
