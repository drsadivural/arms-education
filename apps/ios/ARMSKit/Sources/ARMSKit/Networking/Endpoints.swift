import Foundation

/// Endpoint catalogue for every API operation the iOS app uses
/// (`packages/contracts/openapi.json`, base path `/api/v1`).
public enum API {
  static func id(_ raw: String) -> String {
    // Path ids are UUIDs; percent-encode defensively so that a malformed id can never alter the path.
    raw.lowercased().addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-")))
      ?? raw
  }

  // MARK: Me / auth

  /// `GET /me`. `selectedRole` is sent as `X-ARMS-Selected-Role`; the server answers
  /// `403 ROLE_MISMATCH` when it differs from the DB membership.
  public static func me(selectedRole: Role?) -> Endpoint<DataEnvelope<Me>> {
    var headers: [String: String] = [:]
    if let selectedRole { headers["X-ARMS-Selected-Role"] = selectedRole.rawValue }
    return Endpoint(method: .get, path: "/me", headers: headers)
  }

  /// `PATCH /me/preferences` with `If-Match: "<row_version>"` (0 when never saved).
  public static func updatePreferences(_ input: PreferenceInput, rowVersion: Int) -> Endpoint<ActionResult> {
    Endpoint(method: .patch, path: "/me/preferences", body: Endpoint<ActionResult>.encodeBody(input), ifMatch: rowVersion)
  }

  /// `POST /me/account-deletion`.
  public static func requestAccountDeletion(reason: String?, key: IdempotencyKey) -> Endpoint<ActionResult> {
    let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
    let input = DeleteAccountInput(reason: (trimmed?.isEmpty ?? true) ? nil : trimmed)
    return Endpoint(
      method: .post, path: "/me/account-deletion", body: Endpoint<ActionResult>.encodeBody(input), idempotencyKey: key)
  }

  /// `POST /auth/password-reset` (public; same answer whether or not the account exists).
  public static func passwordReset(email: String) -> Endpoint<ActionResult> {
    Endpoint(
      method: .post, path: "/auth/password-reset",
      body: Endpoint<ActionResult>.encodeBody(PasswordResetInput(email: email)), requiresAuth: false)
  }

  // MARK: Students / progress (teacher scope and self)

  public static func progress(studentId: String) -> Endpoint<StudentProgress> {
    Endpoint(method: .get, path: "/students/\(id(studentId))/progress")
  }

  public static func students(_ query: ListQuery) -> Endpoint<Page<Student>> {
    Endpoint(method: .get, path: "/students", query: query.items)
  }

  public static func student(id studentId: String) -> Endpoint<DataEnvelope<Student>> {
    Endpoint(method: .get, path: "/students/\(id(studentId))")
  }

  public static func classrooms(_ query: ListQuery) -> Endpoint<Page<Classroom>> {
    Endpoint(method: .get, path: "/classrooms", query: query.items)
  }

  public static func teachers(_ query: ListQuery) -> Endpoint<Page<Teacher>> {
    Endpoint(method: .get, path: "/teachers", query: query.items)
  }

  // MARK: Booking

  public static func lessonSlots(_ query: ListQuery) -> Endpoint<Page<LessonSlot>> {
    Endpoint(method: .get, path: "/lesson-slots", query: query.items)
  }

  public static func todayLessons(_ query: ListQuery = ListQuery()) -> Endpoint<Page<LessonSlot>> {
    Endpoint(method: .get, path: "/today-lessons", query: query.items)
  }

  public static func reservations(_ query: ListQuery) -> Endpoint<Page<Reservation>> {
    Endpoint(method: .get, path: "/reservations", query: query.items)
  }

  public static func reservation(id reservationId: String) -> Endpoint<Reservation> {
    Endpoint(method: .get, path: "/reservations/\(id(reservationId))")
  }

  /// `POST /reservations` → `201` with the created (pending) reservation.
  public static func createReservation(slotId: String, key: IdempotencyKey) -> Endpoint<Reservation> {
    Endpoint(
      method: .post, path: "/reservations", body: Endpoint<Reservation>.encodeBody(ReservationInput(slotId: slotId)),
      idempotencyKey: key, successStatuses: [200, 201])
  }

  public static func approveReservation(id reservationId: String, expectedVersion: Int, key: IdempotencyKey)
    -> Endpoint<Reservation>
  {
    decision("approve", reservationId, DecisionInput(expectedVersion: expectedVersion), key)
  }

  public static func rejectReservation(id reservationId: String, expectedVersion: Int, reason: String, key: IdempotencyKey)
    -> Endpoint<Reservation>
  {
    decision("reject", reservationId, DecisionInput(expectedVersion: expectedVersion, reason: reason), key)
  }

  public static func cancelReservation(id reservationId: String, expectedVersion: Int, reason: String?, key: IdempotencyKey)
    -> Endpoint<Reservation>
  {
    decision("cancel", reservationId, DecisionInput(expectedVersion: expectedVersion, reason: reason), key)
  }

  static func decision(_ verb: String, _ reservationId: String, _ input: DecisionInput, _ key: IdempotencyKey)
    -> Endpoint<Reservation>
  {
    Endpoint(
      method: .post, path: "/reservations/\(id(reservationId))/\(verb)", body: Endpoint<Reservation>.encodeBody(input),
      idempotencyKey: key)
  }

  /// `POST /lesson-slots/{id}/attendance` (teacher of the lesson).
  public static func recordAttendance(slotId: String, input: AttendanceInput, key: IdempotencyKey)
    -> Endpoint<ResourceResult>
  {
    Endpoint(
      method: .post, path: "/lesson-slots/\(id(slotId))/attendance", body: Endpoint<ResourceResult>.encodeBody(input),
      idempotencyKey: key)
  }

  // MARK: Learning

  public static func unitMaterials(unitId: String, query: ListQuery = ListQuery(limit: 100)) -> Endpoint<Page<Material>> {
    Endpoint(method: .get, path: "/units/\(id(unitId))/materials", query: query.items)
  }

  public static func materialDownload(id materialId: String) -> Endpoint<DataEnvelope<MaterialDownload>> {
    Endpoint(method: .get, path: "/materials/\(id(materialId))/download")
  }

  public static func materialReceipt(id materialId: String, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/materials/\(id(materialId))/receipt", idempotencyKey: key)
  }

  public static func quiz(materialId: String) -> Endpoint<DataEnvelope<Quiz>> {
    Endpoint(method: .get, path: "/materials/\(id(materialId))/quiz")
  }

  public static func submitQuiz(materialId: String, input: QuizInput, key: IdempotencyKey)
    -> Endpoint<DataEnvelope<QuizResult>>
  {
    Endpoint(
      method: .post, path: "/materials/\(id(materialId))/quiz-attempts",
      body: Endpoint<DataEnvelope<QuizResult>>.encodeBody(input), idempotencyKey: key)
  }

  public static func submitAssignment(materialId: String, input: SubmissionInput, key: IdempotencyKey)
    -> Endpoint<DataEnvelope<Submission>>
  {
    Endpoint(
      method: .post, path: "/materials/\(id(materialId))/submissions",
      body: Endpoint<DataEnvelope<Submission>>.encodeBody(input), idempotencyKey: key)
  }

  public static func reviewSubmission(id submissionId: String, input: ReviewInput, key: IdempotencyKey)
    -> Endpoint<DataEnvelope<Submission>>
  {
    Endpoint(
      method: .post, path: "/submissions/\(id(submissionId))/review",
      body: Endpoint<DataEnvelope<Submission>>.encodeBody(input), idempotencyKey: key)
  }

  /// `GET /submissions` — teacher review queue (latest submission per student and material).
  /// Not part of the base handoff contract: it is added by the learning-area contract extension.
  /// Callers filter the result by `student_id`/`state` themselves so that the screen stays correct
  /// even if the server ignores a query parameter.
  public static func submissions(_ query: ListQuery) -> Endpoint<Page<Submission>> {
    Endpoint(method: .get, path: "/submissions", query: query.items)
  }

  // MARK: Notifications / devices

  public static func notifications(_ query: ListQuery = ListQuery()) -> Endpoint<Page<AppNotification>> {
    Endpoint(method: .get, path: "/notifications", query: query.items)
  }

  public static func markNotificationRead(id notificationId: String) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/notifications/\(id(notificationId))/read")
  }

  public static func registerDevice(_ input: DeviceInput, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/devices", body: Endpoint<ActionResult>.encodeBody(input), idempotencyKey: key)
  }

  // MARK: Voice

  /// `POST /voice/sessions` → short-lived OpenAI client secret (memory only).
  public static func createVoiceSession(key: IdempotencyKey) -> Endpoint<VoiceSessionGrant> {
    Endpoint(method: .post, path: "/voice/sessions", idempotencyKey: key)
  }

  public static func endVoiceSession(id sessionId: String) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/voice/sessions/\(id(sessionId))/end")
  }

  public static func voiceToolCall(_ input: VoiceToolInput, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/voice/tool-calls", body: Endpoint<ActionResult>.encodeBody(input), idempotencyKey: key)
  }
}
