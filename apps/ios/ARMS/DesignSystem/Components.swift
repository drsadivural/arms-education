import ARMSKit
import SwiftUI

/// Rounded surface card (20pt radius, 1pt border).
struct ARMSCard<Content: View>: View {
  var padding: CGFloat = 18
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(padding)
      .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.cardRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: ARMSMetrics.cardRadius, style: .continuous)
          .strokeBorder(ARMSColor.border, lineWidth: 1)
      )
      .shadow(color: Color.black.opacity(0.04), radius: 8, x: 0, y: 2)
  }
}

/// Status tag: colour + always the Japanese label (colour is never the only signal).
struct StatusTag: View {
  let label: String
  let tone: StatusTone

  var body: some View {
    Text(label)
      .font(.caption.weight(.semibold))
      .foregroundStyle(ARMSColor.tagForeground(tone))
      .padding(.horizontal, 10)
      .padding(.vertical, 4)
      .background(ARMSColor.tagBackground(tone), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .accessibilityLabel("状態：\(label)")
  }
}

struct PrimaryButton: View {
  let title: String
  var systemImage: String? = nil
  var isLoading = false
  var isEnabled = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if isLoading {
          ProgressView().tint(ARMSColor.onPrimary)
        } else if let systemImage {
          Image(systemName: systemImage).accessibilityHidden(true)
        }
        Text(title).font(.body.weight(.semibold))
      }
      .frame(maxWidth: .infinity, minHeight: 50)
      .foregroundStyle(ARMSColor.onPrimary)
      .background(
        (isEnabled && !isLoading ? ARMSColor.primary : ARMSColor.primary.opacity(0.45)),
        in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled || isLoading)
    .accessibilityLabel(isLoading ? "\(title)（処理中）" : title)
  }
}

struct SecondaryButton: View {
  let title: String
  var systemImage: String? = nil
  var isLoading = false
  var isEnabled = true
  var role: ButtonRole? = nil
  let action: () -> Void

  var body: some View {
    Button(role: role, action: action) {
      HStack(spacing: 8) {
        if isLoading {
          ProgressView()
        } else if let systemImage {
          Image(systemName: systemImage).accessibilityHidden(true)
        }
        Text(title).font(.body.weight(.medium))
      }
      .frame(maxWidth: .infinity, minHeight: 50)
      .foregroundStyle(role == .destructive ? ARMSColor.danger : ARMSColor.text)
      .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius, style: .continuous)
          .strokeBorder(ARMSColor.border, lineWidth: 1))
      .opacity(isEnabled ? 1 : 0.5)
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled || isLoading)
  }
}

/// Text link styled like 「詳細を見る →」 with a 44pt tap target.
struct LinkButton: View {
  let title: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text("\(title) →")
        .font(.subheadline.weight(.medium))
        .foregroundStyle(ARMSColor.primaryText)
        .frame(minHeight: ARMSMetrics.minTapTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}

/// Information note with a left accent bar (「申請後、担当講師が確認します。…」).
struct InfoNote: View {
  let text: String
  var tone: StatusTone = .info

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(tone == .info ? ARMSColor.primary : ARMSColor.tagForeground(tone))
        .frame(width: 3)
        .accessibilityHidden(true)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(ARMSColor.text)
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
      Spacer(minLength: 0)
    }
    .background(tone == .info ? ARMSColor.infoBackground : ARMSColor.tagBackground(tone))
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

/// 「日時　10月5日（月）」 style row.
struct KeyValueRow: View {
  let label: String
  let value: String
  var showsDivider = true

  var body: some View {
    VStack(spacing: 0) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .firstTextBaseline) {
          Text(label).foregroundStyle(ARMSColor.muted)
          Spacer(minLength: 12)
          Text(value).fontWeight(.semibold).foregroundStyle(ARMSColor.text).multilineTextAlignment(.trailing)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text(label).foregroundStyle(ARMSColor.muted)
          Text(value).fontWeight(.semibold).foregroundStyle(ARMSColor.text)
        }
      }
      .font(.subheadline)
      .padding(.vertical, 12)
      .accessibilityElement(children: .combine)
      if showsDivider { Divider().overlay(ARMSColor.border) }
    }
  }
}

struct SectionHeader: View {
  let title: String
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil

  var body: some View {
    HStack {
      Text(title).font(.title3.bold()).foregroundStyle(ARMSColor.text)
        .accessibilityAddTraits(.isHeader)
      Spacer()
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .font(.subheadline)
          .foregroundStyle(ARMSColor.primaryText)
          .frame(minHeight: ARMSMetrics.minTapTarget)
      }
    }
  }
}

/// Circular progress (研修の進捗). Shows 「未設定」 when the server returned null.
struct ProgressRing: View {
  let fraction: Double?
  let percentText: String
  var lineWidth: CGFloat = 12
  @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 112

  var body: some View {
    ZStack {
      Circle().stroke(ARMSColor.surfaceMuted, lineWidth: lineWidth)
      if let fraction {
        Circle()
          .trim(from: 0, to: fraction)
          .stroke(ARMSColor.primary, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      if fraction != nil, percentText.hasSuffix("%") {
        HStack(alignment: .firstTextBaseline, spacing: 1) {
          Text(String(percentText.dropLast())).font(.largeTitle.weight(.semibold))
          Text("%").font(.subheadline).foregroundStyle(ARMSColor.muted)
        }
        .foregroundStyle(ARMSColor.text)
        .minimumScaleFactor(0.6)
      } else {
        Text(percentText).font(.headline).foregroundStyle(ARMSColor.muted)
      }
    }
    .frame(width: size, height: size)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("研修の進捗")
    .accessibilityValue(percentText)
  }
}

struct LinearProgressBar: View {
  let fraction: Double?
  var label: String? = nil

  var body: some View {
    HStack(spacing: 10) {
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(ARMSColor.surfaceMuted)
          if let fraction {
            Capsule().fill(ARMSColor.primary).frame(width: max(0, min(1, fraction)) * geo.size.width)
          }
        }
      }
      .frame(height: 8)
      if let label {
        Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
          .frame(minWidth: 44, alignment: .trailing)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("進捗")
    .accessibilityValue(label ?? (fraction.map { "\(Int(($0 * 100).rounded()))%" } ?? "未設定"))
  }
}

struct AvatarInitial: View {
  let name: String
  @ScaledMetric private var size: CGFloat = 36

  var body: some View {
    Text(JaFormat.initial(name))
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(ARMSColor.primaryText)
      .frame(width: max(size, ARMSMetrics.minTapTarget - 8), height: max(size, ARMSMetrics.minTapTarget - 8))
      .background(ARMSColor.infoBackground, in: Circle())
      .accessibilityHidden(true)
  }
}

/// H&A logo (original asset, on a white tile) + 「ARMS」.
struct BrandHeader: View {
  var subtitle: String? = nil
  var trailingName: String? = nil
  var onTrailingTap: (() -> Void)? = nil

  var body: some View {
    HStack(spacing: 12) {
      Image("BrandLogo")
        .resizable()
        .interpolation(.high)
        .scaledToFit()
        .frame(width: 66, height: 28)
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(ARMSColor.logoTile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityLabel("H&A")
      VStack(alignment: .leading, spacing: 0) {
        Text("ARMS")
          .font(.title.weight(.bold))
          .foregroundStyle(ARMSColor.primaryText)
        if let subtitle {
          Text(subtitle).font(.caption).foregroundStyle(ARMSColor.primaryText)
        }
      }
      .accessibilityElement(children: .combine)
      Spacer()
      if let trailingName {
        Button {
          onTrailingTap?()
        } label: {
          AvatarInitial(name: trailingName)
            .frame(minWidth: ARMSMetrics.minTapTarget, minHeight: ARMSMetrics.minTapTarget)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("設定（\(trailingName)）")
      }
    }
  }
}

/// Lesson time box 「10:00 / 11:30」.
struct TimeBox: View {
  let start: String
  let end: String

  var body: some View {
    VStack(spacing: 2) {
      Text(start).font(.subheadline.weight(.semibold))
      Text(end).font(.caption)
    }
    .foregroundStyle(ARMSColor.primaryText)
    .frame(minWidth: 60, minHeight: 52)
    .background(ARMSColor.infoBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(start)から\(end)まで")
  }
}

/// Inline banner for action results (errors with request id, or confirmed success).
struct MessageBanner: View {
  enum Kind { case error, success, info }
  let kind: Kind
  let text: String
  var onDismiss: (() -> Void)? = nil

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).foregroundStyle(color).accessibilityHidden(true)
      Text(text).font(.subheadline).foregroundStyle(ARMSColor.text).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if let onDismiss {
        Button(action: onDismiss) {
          Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(ARMSColor.muted)
            .frame(width: ARMSMetrics.minTapTarget, height: ARMSMetrics.minTapTarget)
        }
        .accessibilityLabel("閉じる")
      }
    }
    .padding(.leading, 14)
    .padding(.vertical, onDismiss == nil ? 12 : 0)
    .background(background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(kind == .error ? "エラー：\(text)" : text)
  }

  private var icon: String {
    switch kind {
    case .error: return "exclamationmark.triangle.fill"
    case .success: return "checkmark.circle.fill"
    case .info: return "info.circle.fill"
    }
  }

  private var color: Color {
    switch kind {
    case .error: return ARMSColor.danger
    case .success: return ARMSColor.success
    case .info: return ARMSColor.primaryText
    }
  }

  private var background: Color {
    switch kind {
    case .error: return ARMSColor.tagBackground(.danger)
    case .success: return ARMSColor.tagBackground(.success)
    case .info: return ARMSColor.infoBackground
    }
  }
}

extension View {
  /// Standard screen background and horizontal gutter.
  func armsScreen() -> some View {
    self.background(ARMSColor.background.ignoresSafeArea())
  }
}
