import Foundation

extension VoiceTool {
  /// Teachers may only read by voice (progress of their students, their lessons, reservation status).
  /// Approve/reject/remove and any reservation write stay in the explicit screen UI.
  public func isAllowed(for role: Role) -> Bool {
    switch role {
    case .student: return true
    case .teacher: return intent == nil
    case .admin: return false
    }
  }
}

/// Confirmation card prepared by the server (`prepare_reservation` / `prepare_cancellation`).
/// The server stores only a hash of the 256-bit action token and binds it to user/session/intent;
/// the card expires 120 seconds after preparation.
public struct VoiceConfirmationCard: Sendable, Equatable, Identifiable {
  public static let defaultLifetime: TimeInterval = 120

  public let intent: VoiceIntent
  public let actionToken: String
  public let expiresAt: Date
  /// Sentence read to the user, e.g. 「10月5日（月）14時からのIT基礎を予約申請します。申請してよろしいですか？」.
  public let prompt: String
  public let lessonTitle: String?
  public let startsAt: Date?
  public let endsAt: Date?
  public let teacherName: String?
  public let classroomName: String?
  public let studentName: String?
  public let reservationId: String?
  public let slotId: String?

  public var id: String { actionToken }

  public init(
    intent: VoiceIntent, actionToken: String, expiresAt: Date, prompt: String, lessonTitle: String? = nil,
    startsAt: Date? = nil, endsAt: Date? = nil, teacherName: String? = nil, classroomName: String? = nil,
    studentName: String? = nil, reservationId: String? = nil, slotId: String? = nil
  ) {
    self.intent = intent
    self.actionToken = actionToken
    self.expiresAt = expiresAt
    self.prompt = prompt
    self.lessonTitle = lessonTitle
    self.startsAt = startsAt
    self.endsAt = endsAt
    self.teacherName = teacherName
    self.classroomName = classroomName
    self.studentName = studentName
    self.reservationId = reservationId
    self.slotId = slotId
  }

  /// Parses the `data` object of a successful prepare tool call. Accepted shape (keys optional
  /// except `action_token`):
  /// `{ action_token, expires_at, summary_ja | confirmation_ja | message_ja,
  ///    slot: {id, title, starts_at, ends_at, teacher_name, classroom_name},
  ///    reservation: {id, slot_title, starts_at, ends_at, teacher_name, classroom_name, student_name},
  ///    student_name }`
  public static func parse(data: JSONValue?, intent: VoiceIntent, receivedAt: Date, calendar: OrgCalendar)
    -> VoiceConfirmationCard?
  {
    guard let data, let token = data["action_token"]?.stringValue, token.count >= 32 else { return nil }
    let maxExpiry = receivedAt.addingTimeInterval(defaultLifetime)
    let serverExpiry = data["expires_at"]?.stringValue.flatMap(ISO8601.parse)
    // Never extend beyond 120 s locally even if the server clock says otherwise.
    let expiresAt = min(serverExpiry ?? maxExpiry, maxExpiry)
    let target = data["slot"] ?? data["reservation"] ?? data
    func str(_ v: JSONValue?, _ keys: String...) -> String? {
      for k in keys { if let s = v?[k]?.stringValue, !s.isEmpty { return s } }
      return nil
    }
    let title = str(target, "title", "slot_title")
    let startsAt = str(target, "starts_at").flatMap(ISO8601.parse)
    let endsAt = str(target, "ends_at").flatMap(ISO8601.parse)
    let teacher = str(target, "teacher_name") ?? str(data, "teacher_name")
    let classroom = str(target, "classroom_name") ?? str(data, "classroom_name")
    let student = str(data, "student_name") ?? str(target, "student_name")
    let prompt =
      str(data, "summary_ja", "confirmation_ja", "message_ja")
      ?? defaultPrompt(intent: intent, title: title, startsAt: startsAt, teacher: teacher, calendar: calendar)
    return VoiceConfirmationCard(
      intent: intent, actionToken: token, expiresAt: expiresAt, prompt: prompt, lessonTitle: title,
      startsAt: startsAt, endsAt: endsAt, teacherName: teacher, classroomName: classroom, studentName: student,
      reservationId: intent == .cancel ? (str(data["reservation"], "id") ?? str(data, "reservation_id")) : nil,
      slotId: str(data["slot"], "id") ?? str(data, "slot_id"))
  }

  static func defaultPrompt(intent: VoiceIntent, title: String?, startsAt: Date?, teacher: String?, calendar: OrgCalendar)
    -> String
  {
    var subject = ""
    if let startsAt {
      let p = calendar.parts(of: startsAt)
      let minute = p.minute == 0 ? "" : "\(p.minute)分"
      subject += "\(JaFormat.instantDate(startsAt, calendar: calendar, withYear: false))\(p.hour)時\(minute)から"
    }
    if let teacher { subject += "、\(JaFormat.familyName(teacher))講師" }
    if let title { subject += (subject.isEmpty ? "" : "の") + title }
    if subject.isEmpty { subject = "選択した授業" }
    switch intent {
    case .reserve: return "\(subject)を予約申請します。申請してよろしいですか？"
    case .cancel: return "\(subject)の予約を取り消します。取り消してよろしいですか？"
    }
  }

  public func remainingSeconds(now: Date) -> Int {
    max(0, Int(expiresAt.timeIntervalSince(now).rounded(.up)))
  }

  public func isExpired(now: Date) -> Bool { now >= expiresAt }

  /// 「確認内容の有効時間：残り1分45秒」.
  public func remainingLabel(now: Date) -> String {
    isExpired(now: now)
      ? "確認内容の有効期限が切れました"
      : "確認内容の有効時間：残り\(JaFormat.duration(seconds: remainingSeconds(now: now)))"
  }

  public var confirmButtonTitle: String {
    intent == .reserve ? "この内容で申請する" : "この予約を取り消す"
  }

  public var voiceHint: String {
    intent == .reserve
      ? "「はい、申請して」と話すか、下のボタンを押してください。まだ申請は送信されていません。"
      : "「はい、取り消して」と話すか、下のボタンを押してください。まだ取消は送信されていません。"
  }
}

/// How the user confirmed.
public enum ConfirmationMethod: Sendable, Equatable {
  case button
  case voice(transcript: String)
  case text(String)
}

/// Confirmation state. A commit is allowed only from `.confirmed` with the same token and intent,
/// before expiry. Anything else is refused locally without calling the API.
public enum ConfirmationState: Sendable, Equatable {
  case none
  case awaiting(VoiceConfirmationCard)
  case confirmed(VoiceConfirmationCard, ConfirmationMethod)
  case committing(VoiceConfirmationCard)
  case committed(VoiceConfirmationCard, resultMessage: String)
  case failed(VoiceConfirmationCard, message: String)
  case expired(VoiceConfirmationCard)
  case discarded

  public var card: VoiceConfirmationCard? {
    switch self {
    case .awaiting(let c), .confirmed(let c, _), .committing(let c), .committed(let c, _), .failed(let c, _),
      .expired(let c):
      return c
    case .none, .discarded:
      return nil
    }
  }

  public var isAwaitingUser: Bool {
    if case .awaiting = self { return true }
    return false
  }
}

public struct ConfirmationMachine: Sendable, Equatable {
  public private(set) var state: ConfirmationState = .none

  public init() {}

  public mutating func present(_ card: VoiceConfirmationCard) {
    state = .awaiting(card)
  }

  /// Marks expiry when the 120 s window passed (call on every tick).
  public mutating func tick(now: Date) {
    switch state {
    case .awaiting(let card), .confirmed(let card, _):
      if card.isExpired(now: now) { state = .expired(card) }
    default: break
    }
  }

  /// Records an explicit confirmation (button, or an utterance classified as explicit).
  @discardableResult
  public mutating func confirm(_ method: ConfirmationMethod, now: Date) -> Bool {
    guard case .awaiting(let card) = state else { return false }
    guard !card.isExpired(now: now) else {
      state = .expired(card)
      return false
    }
    state = .confirmed(card, method)
    return true
  }

  /// Gate for a commit request (from the model or the button). Returns the card to commit.
  public mutating func authorizeCommit(token: String, intent: VoiceIntent, now: Date) -> Result<
    VoiceConfirmationCard, VoiceToolRejection
  > {
    switch state {
    case .confirmed(let card, _):
      guard !card.isExpired(now: now) else {
        state = .expired(card)
        return .failure(.confirmationExpired)
      }
      guard card.actionToken == token, card.intent == intent else { return .failure(.confirmationMismatch) }
      state = .committing(card)
      return .success(card)
    case .awaiting(let card):
      if card.isExpired(now: now) {
        state = .expired(card)
        return .failure(.confirmationExpired)
      }
      return .failure(card.actionToken == token ? .confirmationRequired : .confirmationMismatch)
    case .expired:
      return .failure(.confirmationExpired)
    case .committing(let card):
      // A duplicate commit while the first is in flight is not sent twice.
      return .failure(card.actionToken == token ? .confirmationRequired : .confirmationMismatch)
    case .committed, .failed, .none, .discarded:
      return .failure(.confirmationRequired)
    }
  }

  public mutating func finishCommit(success: Bool, message: String) {
    guard case .committing(let card) = state else { return }
    state = success ? .committed(card, resultMessage: message) : .failed(card, message: message)
  }

  /// 「内容を変更する」, a new session, or a new prepare replaces the card.
  public mutating func discard() {
    state = .discarded
  }

  public mutating func reset() { state = .none }
}

/// Classifies a user utterance as an explicit confirmation. Bare back-channel replies
/// (「はい」「うん」「ええ」), questions, hesitations and negations are not confirmations.
public enum AffirmationClassifier {
  public enum Verdict: Equatable, Sendable {
    case confirmed
    case rejected
    case ambiguous
  }

  static let negative = [
    "いいえ", "いえ", "やめ", "止め", "待って", "まって", "違う", "ちがう", "変更", "しない", "しません", "だめ", "ダメ", "キャンセルしない",
    "取り消さない", "申請しない", "予約しない", "ちょっと",
  ]
  static let hesitation = ["えっと", "えーと", "うーん", "あの", "かな", "どうしよう", "たぶん", "多分", "かも"]
  static let generic = ["お願いします", "お願い", "おねがいします", "おねがい", "確定して", "確定", "実行して", "それで", "その内容で"]
  static let reserveVerbs = ["申請して", "申請する", "申請します", "申請お願い", "予約して", "予約する", "予約します", "予約お願い"]
  static let cancelVerbs = ["取り消して", "取消して", "取り消す", "取り消します", "取消します", "キャンセルして", "キャンセルする", "キャンセルします"]

  public static func classify(_ utterance: String, intent: VoiceIntent) -> Verdict {
    let normalized = normalize(utterance)
    guard !normalized.isEmpty else { return .ambiguous }
    if negative.contains(where: { normalized.contains(normalize($0)) }) { return .rejected }
    if utterance.contains("?") || utterance.contains("？") || normalized.hasSuffix("か") || normalized.hasSuffix("ですか")
      || normalized.hasSuffix("でしょうか")
    {
      return .ambiguous
    }
    if hesitation.contains(where: { normalized.contains($0) }) { return .ambiguous }
    let ownVerbs = intent == .reserve ? reserveVerbs : cancelVerbs
    let otherVerbs = intent == .reserve ? cancelVerbs : reserveVerbs
    if otherVerbs.contains(where: { normalized.contains($0) }) && !ownVerbs.contains(where: { normalized.contains($0) }) {
      return .ambiguous
    }
    if ownVerbs.contains(where: { normalized.contains($0) }) { return .confirmed }
    if generic.contains(where: { normalized.contains($0) }) { return .confirmed }
    return .ambiguous
  }

  static func normalize(_ s: String) -> String {
    let removable = CharacterSet.whitespacesAndNewlines
      .union(CharacterSet(charactersIn: "、。，．,.!！・「」『』…〜~\u{3000}"))
    return String(String.UnicodeScalarView(s.lowercased().unicodeScalars.filter { !removable.contains($0) }))
  }
}
