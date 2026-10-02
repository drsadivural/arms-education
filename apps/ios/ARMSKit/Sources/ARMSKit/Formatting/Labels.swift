import Foundation

/// Semantic tone of a status tag. Colour is never the only signal: tags always render `labelJa`.
public enum StatusTone: String, Sendable, Hashable {
  case success
  case warning
  case danger
  case info
  case neutral
}

extension Role {
  public var labelJa: String {
    switch self {
    case .admin: return "管理者"
    case .teacher: return "講師"
    case .student: return "受講者"
    }
  }
}

extension SelectableRole {
  public var labelJa: String { role.labelJa }
}

extension ReservationStatus {
  /// Mirrors `RESERVATION_STATUS_LABELS` in `packages/contracts/src/labels.ts`.
  public var labelJa: String {
    switch self {
    case .pending: return "承認待ち"
    case .approved: return "承認済み"
    case .rejected: return "却下"
    case .cancelled: return "取消済み"
    case .expired: return "申請期限切れ"
    case .removed: return "削除済み"
    }
  }

  public var tone: StatusTone {
    switch self {
    case .pending: return .warning
    case .approved: return .success
    case .rejected: return .danger
    case .cancelled, .expired, .removed: return .neutral
    }
  }

  /// Statuses that hold a seat (pending until `expires_at`).
  public var holdsSeat: Bool { self == .pending || self == .approved }
}

extension UnitState {
  public var labelJa: String {
    switch self {
    case .notStarted: return "未着手"
    case .inProgress: return "受講中"
    case .reviewPending: return "確認待ち"
    case .completed: return "完了"
    }
  }

  public var tone: StatusTone {
    switch self {
    case .notStarted: return .neutral
    case .inProgress: return .info
    case .reviewPending: return .warning
    case .completed: return .success
    }
  }
}

extension AttendanceState {
  public var labelJa: String {
    switch self {
    case .present: return "出席"
    case .absent: return "欠席"
    case .late: return "遅刻"
    case .excused: return "公欠"
    }
  }
}

extension MaterialKind {
  public var labelJa: String {
    switch self {
    case .pdf: return "PDF"
    case .video: return "動画"
    case .image: return "画像"
    case .link: return "外部リンク"
    case .quiz: return "確認テスト"
    case .assignment: return "課題"
    }
  }
}

extension ScanState {
  public var labelJa: String {
    switch self {
    case .pending: return "検査待ち"
    case .clean: return "検査済み"
    case .blocked: return "公開不可（検出）"
    case .notApplicable: return "検査対象外"
    }
  }
}

extension SubmissionState {
  public var labelJa: String {
    switch self {
    case .submitted: return "提出済み（確認待ち）"
    case .accepted: return "承認"
    case .revisionRequested: return "再提出依頼"
    }
  }

  public var tone: StatusTone {
    switch self {
    case .submitted: return .warning
    case .accepted: return .success
    case .revisionRequested: return .danger
    }
  }
}

extension SlotState {
  public var labelJa: String {
    switch self {
    case .open: return "受付中"
    case .closed: return "受付終了"
    case .cancelled: return "取消"
    }
  }
}

extension ThemePreference {
  /// iOS wording follows the IOS-18 design (「システムに合わせる」).
  public var labelJa: String {
    switch self {
    case .light: return "ライト"
    case .dark: return "ダーク"
    case .system: return "システムに合わせる"
    }
  }
}
