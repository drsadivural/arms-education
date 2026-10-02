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

  /// `POST /auth/password-reset` (public; the server chooses the redirect and answers identically
  /// whether or not the account exists; `data.message_ja` carries the text to show).
  public static func passwordReset(email: String) -> Endpoint<ActionResult> {
    Endpoint(
      method: .post, path: "/auth/password-reset",
      body: Endpoint<ActionResult>.encodeBody(PasswordResetInput(email: email)), requiresAuth: false)
  }

  // MARK: Students / progress (teacher scope and self)

  /// `GET /students/{id}/progress` — a bare `Progress` object (not wrapped in `data`).
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

  /// `GET /lesson-slots/{id}` (out-of-scope → 404; ETag = row_version).
  public static func lessonSlot(id slotId: String) -> Endpoint<DataEnvelope<LessonSlot>> {
    Endpoint(method: .get, path: "/lesson-slots/\(id(slotId))")
  }

  /// `GET /today-lessons` (organisation-timezone today). Only `cursor`/`limit` are honoured.
  public static func todayLessons(_ query: ListQuery = ListQuery()) -> Endpoint<Page<LessonSlot>> {
    Endpoint(method: .get, path: "/today-lessons", query: query.items)
  }

  /// `GET /reservations` — `status` is comma separated, `removed` only when requested explicitly,
  /// `slot_id`, `sort`, and `idempotency_key` (the caller's own request) are supported.
  public static func reservations(_ query: ListQuery) -> Endpoint<Page<Reservation>> {
    Endpoint(method: .get, path: "/reservations", query: query.items)
  }

  /// `GET /reservations/{id}` — a bare `Reservation` with `history`.
  public static func reservation(id reservationId: String) -> Endpoint<Reservation> {
    Endpoint(method: .get, path: "/reservations/\(id(reservationId))")
  }

  /// `POST /reservations` → `201` with the created (pending) bare reservation. The Idempotency-Key is
  /// also the database idempotency key: the same key + slot returns the same reservation.
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

  /// Decisions answer with the bare updated `Reservation` (200).
  static func decision(_ verb: String, _ reservationId: String, _ input: DecisionInput, _ key: IdempotencyKey)
    -> Endpoint<Reservation>
  {
    Endpoint(
      method: .post, path: "/reservations/\(id(reservationId))/\(verb)", body: Endpoint<Reservation>.encodeBody(input),
      idempotencyKey: key)
  }

  /// `GET /lesson-slots/{id}/attendance` — roster (approved reservations + existing records).
  public static func attendanceRoster(slotId: String) -> Endpoint<DataEnvelope<AttendanceRoster>> {
    Endpoint(method: .get, path: "/lesson-slots/\(id(slotId))/attendance")
  }

  /// `POST /lesson-slots/{id}/attendance` (teacher of the lesson). `409 ATTENDANCE_NOT_OPEN` before
  /// 30 minutes ahead of the start, `409 SLOT_CANCELLED` for cancelled slots.
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

  /// `GET /materials/{id}` (students: assigned, published, scanned materials only; others 404).
  public static func material(id materialId: String) -> Endpoint<DataEnvelope<Material>> {
    Endpoint(method: .get, path: "/materials/\(id(materialId))")
  }

  public static func materialDownload(id materialId: String) -> Endpoint<DataEnvelope<MaterialDownload>> {
    Endpoint(method: .get, path: "/materials/\(id(materialId))/download")
  }

  /// `POST /materials/{id}/receipt` → `data: {material_id, confirmed_at, unit_state}`.
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

  /// `POST /submissions/{id}/review` with `expected_version` (409 VERSION_CONFLICT when stale).
  public static func reviewSubmission(id submissionId: String, input: ReviewInput, key: IdempotencyKey)
    -> Endpoint<DataEnvelope<Submission>>
  {
    Endpoint(
      method: .post, path: "/submissions/\(id(submissionId))/review",
      body: Endpoint<DataEnvelope<Submission>>.encodeBody(input), idempotencyKey: key)
  }

  /// `GET /submissions` — teacher review queue: the latest submission per student × assignment,
  /// newest first; filters `state`, `student_id`, `classroom_id`, `material_id` (teachers: own students).
  public static func submissions(_ query: ListQuery) -> Endpoint<Page<Submission>> {
    Endpoint(method: .get, path: "/submissions", query: query.items)
  }

  /// `GET /submissions/{id}/file` — 5-minute URL of the scanned file (`attachment`).
  public static func submissionFile(id submissionId: String) -> Endpoint<DataEnvelope<MaterialDownload>> {
    Endpoint(method: .get, path: "/submissions/\(id(submissionId))/file")
  }

  // MARK: Uploads

  /// `POST /uploads` → 15-minute presigned PUT into quarantine.
  public static func createUpload(_ input: UploadInput, key: IdempotencyKey) -> Endpoint<DataEnvelope<UploadTicket>> {
    Endpoint(
      method: .post, path: "/uploads", body: Endpoint<DataEnvelope<UploadTicket>>.encodeBody(input), idempotencyKey: key)
  }

  /// `POST /uploads/{id}/complete` → size + content verification, then the scanner. Naturally
  /// idempotent on the server (an already-verified upload answers its current state); a key is sent
  /// so the request is retried after transport failures.
  public static func completeUpload(id uploadId: String, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/uploads/\(id(uploadId))/complete", idempotencyKey: key)
  }

  public static func upload(id uploadId: String) -> Endpoint<DataEnvelope<UploadStatus>> {
    Endpoint(method: .get, path: "/uploads/\(id(uploadId))")
  }

  // MARK: Notifications / devices

  /// `GET /notifications` — `status` = all / unread / read; newest first.
  public static func notifications(_ query: ListQuery = ListQuery()) -> Endpoint<Page<AppNotification>> {
    Endpoint(method: .get, path: "/notifications", query: query.items)
  }

  public static func markNotificationRead(id notificationId: String) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/notifications/\(id(notificationId))/read")
  }

  /// `POST /notifications/read-all` → `data: {updated}`.
  public static func markAllNotificationsRead() -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/notifications/read-all")
  }

  /// `POST /devices` → `data: {token_hash, environment}` (503 NOT_CONFIGURED without APNs keys).
  public static func registerDevice(_ input: DeviceInput, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/devices", body: Endpoint<ActionResult>.encodeBody(input), idempotencyKey: key)
  }

  /// `DELETE /devices/{token_hash}` (sign-out; idempotent, no If-Match).
  public static func unregisterDevice(tokenHash: String) -> Endpoint<ActionResult> {
    let hash = tokenHash.lowercased().filter { $0.isHexDigit }
    return Endpoint(method: .delete, path: "/devices/\(hash)")
  }

  // MARK: Voice

  /// `POST /voice/sessions` → short-lived OpenAI client secret (memory only).
  public static func createVoiceSession(key: IdempotencyKey) -> Endpoint<VoiceSessionGrant> {
    Endpoint(method: .post, path: "/voice/sessions", idempotencyKey: key)
  }

  /// `POST /voice/sessions/{id}/end` → `data: {session_id, consumed_seconds}` (idempotent).
  public static func endVoiceSession(id sessionId: String) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/voice/sessions/\(id(sessionId))/end")
  }

  /// `POST /voice/tool-calls` — business failures are `200 success:false data:{error_code, message_ja}`.
  public static func voiceToolCall(_ input: VoiceToolInput, key: IdempotencyKey) -> Endpoint<ActionResult> {
    Endpoint(method: .post, path: "/voice/tool-calls", body: Endpoint<ActionResult>.encodeBody(input), idempotencyKey: key)
  }

  /// `GET /voice/quota` — today's usage (Settings and the voice screen).
  public static func voiceQuota() -> Endpoint<DataEnvelope<VoiceQuota>> {
    Endpoint(method: .get, path: "/voice/quota")
  }
}
