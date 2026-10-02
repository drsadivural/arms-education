import Foundation
import XCTest

@testable import ARMSKit

@MainActor
final class SessionStoreTests: XCTestCase {
  func makeStore(_ t: MockTransport, tokens: StubTokens = StubTokens(), keyValues: InMemoryKeyValueStore = InMemoryKeyValueStore(), cache: InMemoryResponseCache = InMemoryResponseCache())
    -> SessionStore
  {
    let context = makeContext(t, me: nil, tokens: tokens, cache: cache, keyValues: keyValues)
    return SessionStore(auth: tokens, context: context)
  }

  func testStudentSignInVerifiesRoleWithServer() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let tokens = StubTokens()
    tokens.signedIn = false
    let store = makeStore(t, tokens: tokens)
    store.selectedRole = .student
    await store.signIn(email: " wada@example.invalid ", password: "pw")
    XCTAssertEqual(store.me?.displayName, "和田 一夫")
    XCTAssertEqual(t.requests.first?.header("X-ARMS-Selected-Role"), "student")
    XCTAssertEqual(store.context.me?.id, Fixtures.studentId)
    XCTAssertNil(store.message)
  }

  func testRoleMismatchSignsOut() async {
    let t = MockTransport()
    t.on(.get, "/me") { request, _ in
      if request.header("X-ARMS-Selected-Role") != nil {
        return HTTPResponse(
          status: 403,
          body: Data(Fixtures.errorJSON("ROLE_MISMATCH", "このアカウントでは選択した利用区分にログインできません。").utf8))
      }
      return HTTPResponse(status: 200, body: Data(Fixtures.meJSON(role: "student").utf8))
    }
    let tokens = StubTokens()
    let store = makeStore(t, tokens: tokens)
    store.selectedRole = .teacher
    await store.signIn(email: "wada@example.invalid", password: "pw")
    XCTAssertEqual(store.state, .signedOut)
    XCTAssertEqual(store.message, "このアカウントでは選択した利用区分にログインできません")
    XCTAssertEqual(tokens.signOutCount, 1)
    XCTAssertNil(store.context.me)
  }

  func testAdministratorIsSentToWeb() async {
    let t = MockTransport()
    t.on(.get, "/me") { request, _ in
      request.header("X-ARMS-Selected-Role") != nil
        ? HTTPResponse(
          status: 403, body: Data(Fixtures.errorJSON("ROLE_MISMATCH", "このアカウントでは選択した利用区分にログインできません。").utf8))
        : HTTPResponse(status: 200, body: Data(Fixtures.meJSON(role: "admin").utf8))
    }
    let tokens = StubTokens()
    let store = makeStore(t, tokens: tokens)
    await store.signIn(email: "admin@example.invalid", password: "pw")
    XCTAssertEqual(store.state, .signedOut)
    XCTAssertEqual(store.message, "管理者の操作はWeb管理画面をご利用ください。")
    XCTAssertEqual(tokens.signOutCount, 1)

    let t2 = MockTransport()
    t2.on(.get, "/me", status: 403, json: Fixtures.errorJSON("ADMIN_USE_WEB", "管理者の操作はWeb管理画面をご利用ください。"))
    let store2 = makeStore(t2)
    await store2.signIn(email: "admin@example.invalid", password: "pw")
    XCTAssertEqual(store2.message, "管理者の操作はWeb管理画面をご利用ください。")
  }

  func testInvalidCredentialsAndValidation() async {
    let t = MockTransport()
    let tokens = StubTokens()
    tokens.signInError = .auth(.invalidCredentials)
    let store = makeStore(t, tokens: tokens)
    await store.signIn(email: "", password: "")
    XCTAssertEqual(store.fieldErrors["email"], "メールアドレスを入力してください。")
    XCTAssertEqual(store.fieldErrors["password"], "パスワードを入力してください。")
    XCTAssertEqual(tokens.signInCount, 0)
    await store.signIn(email: "bad-address", password: "x")
    XCTAssertEqual(store.fieldErrors["email"], "メールアドレスの形式が正しくありません。")
    await store.signIn(email: "wada@example.invalid", password: "wrong")
    XCTAssertEqual(store.message, "メールアドレスまたはパスワードが正しくありません。")
    XCTAssertTrue(t.requests.isEmpty)
  }

  func testOrganizationSelection() async {
    let t = MockTransport()
    t.on(.get, "/me") { request, _ in
      request.header("X-ARMS-Org") == Fixtures.orgId
        ? HTTPResponse(status: 200, body: Data(Fixtures.meJSON().utf8))
        : HTTPResponse(
          status: 409,
          body: Data(
            Fixtures.errorJSON(
              "ORG_SELECTION_REQUIRED", "利用する組織を選択してください。",
              extra: #","details":{"organizations":[{"id":"\#(Fixtures.orgId)","name":"H&A研修センター"},{"id":"o2","name":"別組織"}]}"#
            ).utf8))
    }
    let keyValues = InMemoryKeyValueStore()
    let store = makeStore(t, keyValues: keyValues)
    await store.signIn(email: "wada@example.invalid", password: "pw")
    guard case .choosingOrganization(let choices) = store.state else { return XCTFail("expected org choice") }
    XCTAssertEqual(choices.map(\.name), ["H&A研修センター", "別組織"])
    await store.chooseOrganization(choices[0])
    XCTAssertEqual(store.me?.organization.id, Fixtures.orgId)
    XCTAssertEqual(keyValues.string(forKey: StorageKeys.organizationId), Fixtures.orgId)
  }

  func testRestoreOfflineUsesCachedProfileReadOnly() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let cache = InMemoryResponseCache()
    let keyValues = InMemoryKeyValueStore()
    let store = makeStore(t, keyValues: keyValues, cache: cache)
    await store.restore()
    XCTAssertNotNil(store.me)

    let offline = MockTransport()
    offline.on(.get, "/me", error: .offline)
    let store2 = makeStore(offline, keyValues: keyValues, cache: cache)
    await store2.restore()
    XCTAssertEqual(store2.me?.id, Fixtures.studentId)
    XCTAssertTrue(store2.isOfflineSession)
    XCTAssertFalse(store2.context.canMutate)

    let store3 = makeStore(offline, keyValues: InMemoryKeyValueStore(), cache: InMemoryResponseCache())
    await store3.restore()
    XCTAssertEqual(store3.state, .restoreFailed(ARMSError.offline.messageJa))
  }

  func testSelectedRoleIsRemembered() {
    let keyValues = InMemoryKeyValueStore()
    let store = makeStore(MockTransport(), keyValues: keyValues)
    XCTAssertEqual(store.selectedRole, .student)
    store.selectedRole = .teacher
    XCTAssertEqual(keyValues.string(forKey: StorageKeys.selectedRole), "teacher")
    XCTAssertEqual(makeStore(MockTransport(), keyValues: keyValues).selectedRole, .teacher)
  }

  func testRestoreWithoutSessionShowsLogin() async {
    let tokens = StubTokens()
    tokens.signedIn = false
    let store = makeStore(MockTransport(), tokens: tokens)
    await store.restore()
    XCTAssertEqual(store.state, .signedOut)
  }

  func testSessionExpiryAndSignOutWipeCache() async {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let cache = InMemoryResponseCache()
    let store = makeStore(t, cache: cache)
    await store.restore()
    XCTAssertGreaterThan(cache.count, 0)
    await store.handleSessionExpired()
    XCTAssertEqual(store.state, .signedOut)
    XCTAssertEqual(store.message, "セッションの有効期限が切れました。再度ログインしてください。")
    XCTAssertEqual(cache.count, 0)
  }

  func testPasswordReset() async {
    let t = MockTransport()
    t.on(.post, "/auth/password-reset", json: Fixtures.actionJSON())
    let store = makeStore(t)
    let invalid = await store.requestPasswordReset(email: "nope")
    XCTAssertEqual((try? invalid.get()), nil)
    let ok = await store.requestPasswordReset(email: "wada@example.invalid")
    XCTAssertEqual(try ok.get(), SessionStore.passwordResetSentMessage)
    XCTAssertEqual(body(t.requests[0])?["email"], "wada@example.invalid")
  }
}

@MainActor
final class AppContextTests: XCTestCase {
  func testFetchCachesAndFallsBackOffline() async {
    let t = MockTransport()
    t.on(.get, "/today-lessons", json: Fixtures.page([Fixtures.slotJSON()]))
    let cache = InMemoryResponseCache()
    let context = makeContext(t, cache: cache)
    let api = context.api
    let fresh = await context.fetch(cacheKey: "today", checkedAt: { $0.checkedAt }) { try await api.send(API.todayLessons()).value }
    guard case .fresh(let page, _) = fresh else { return XCTFail("expected fresh") }
    XCTAssertEqual(page.items.count, 1)
    XCTAssertTrue(context.isOnline)

    t.on(.get, "/today-lessons", error: .offline)
    var state = Loadable<Page<LessonSlot>>()
    state.beginLoading()
    state.apply(await context.fetch(cacheKey: "today", checkedAt: { $0.checkedAt }) { try await api.send(API.todayLessons()).value })
    XCTAssertTrue(state.isCached)
    XCTAssertEqual(state.value?.items.count, 1)
    XCTAssertEqual(state.error, .offline)
    XCTAssertFalse(context.isOnline)
    XCTAssertFalse(context.canMutate)
    XCTAssertEqual(context.lastUpdatedLabel(state), "最終更新 11:00（オフライン表示）")
    XCTAssertEqual(context.mutationBlocker()?.messageJa, AppContext.offlineMutationMessage)
  }

  func testServerErrorsDoNotUseCache() async {
    let t = MockTransport()
    t.on(.get, "/today-lessons", json: Fixtures.page([Fixtures.slotJSON()]))
    let context = makeContext(t)
    let api = context.api
    _ = await context.fetch(cacheKey: "today", checkedAt: { $0.checkedAt }) { try await api.send(API.todayLessons()).value }
    t.on(.get, "/today-lessons", status: 403, json: Fixtures.errorJSON("FORBIDDEN", "この操作を行う権限がありません。"))
    let outcome = await context.fetch(cacheKey: "today", checkedAt: { $0.checkedAt }) { try await api.send(API.todayLessons()).value }
    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "FORBIDDEN")
  }

  func testCacheIsNamespacedPerUser() async {
    let t = MockTransport()
    let cache = InMemoryResponseCache()
    let context = makeContext(t, cache: cache)
    context.storeCached(["x": 1], savedAt: fixedNow, key: "k")
    context.setMe(Fixtures.teacherMe)
    XCTAssertNil(context.loadCached([String: Int].self, key: "k"))
    context.setMe(Fixtures.studentMe)
    XCTAssertEqual(context.loadCached([String: Int].self, key: "k")?.value, ["x": 1])
  }

  func testLoadableKeepsValueOnFailure() {
    var l = Loadable<Int>()
    XCTAssertFalse(l.isInitialLoading)
    l.beginLoading()
    XCTAssertTrue(l.isInitialLoading)
    l.apply(.fresh(3, checkedAt: fixedNow))
    l.beginLoading()
    l.apply(.failure(.timedOut))
    XCTAssertEqual(l.value, 3)
    XCTAssertEqual(l.error, .timedOut)
    XCTAssertFalse(l.failedWithoutValue)
    var empty = Loadable<Int>()
    empty.apply(.failure(.offline))
    XCTAssertTrue(empty.failedWithoutValue)
  }
}

@MainActor
final class BookingModelTests: XCTestCase {
  func testCalendarMarksBookableDaysAndSelectsDate() async {
    let t = MockTransport()
    t.on(
      .get, "/lesson-slots",
      json: Fixtures.page([
        Fixtures.slotJSON(id: "a"),
        Fixtures.slotJSON(id: "b", title: "研修振り返り面談", startsAt: "2026-10-05T07:00:00Z", endsAt: "2026-10-05T08:00:00Z", remaining: 0),
        Fixtures.slotJSON(id: "c", startsAt: "2026-10-06T01:00:00Z", endsAt: "2026-10-06T02:00:00Z", remaining: 0),
      ]))
    let model = BookingModel(context: makeContext(t))
    XCTAssertEqual(model.monthTitle, "2026年10月")
    XCTAssertEqual(model.selectedDate, LocalDate("2026-10-02"))
    await model.load()
    XCTAssertTrue(t.requests[0].url.query?.contains("month=2026-10") ?? false)
    XCTAssertTrue(model.hasBookableSlots(on: LocalDate("2026-10-05")!))
    XCTAssertFalse(model.hasBookableSlots(on: LocalDate("2026-10-06")!))
    XCTAssertTrue(model.hasSlots(on: LocalDate("2026-10-06")!))
    XCTAssertEqual(model.selectedDate, LocalDate("2026-10-05"), "jumps to the first day with a free slot")
    model.select(LocalDate("2026-10-06")!)
    XCTAssertEqual(model.slotsForSelectedDate.map(\.id), ["c"])
    model.select(LocalDate("2026-10-05")!)
    XCTAssertEqual(model.selectedDateTitle, "10月5日（月）の空き枠")
    XCTAssertEqual(model.slotsForSelectedDate.map(\.id), ["a", "b"])
    XCTAssertFalse(model.canGoToPreviousMonth)
    await model.showMonth(YearMonth("2026-11")!)
    XCTAssertEqual(model.selectedDate, LocalDate("2026-11-01"))
    XCTAssertTrue(t.requests.last?.url.query?.contains("month=2026-11") ?? false)
  }

  func testConfirmSubmitsOncePerActionAndShowsPendingOnlyAfter201() async {
    let t = MockTransport()
    t.on(.post, "/reservations") { _, _ in
      Thread.sleep(forTimeInterval: 0.05)
      return HTTPResponse(status: 201, body: Data(Fixtures.reservationJSON().utf8))
    }
    let model = BookingConfirmModel(slot: Fixtures.slot(), context: makeContext(t))
    XCTAssertNil(model.successMessage)
    async let a: Void = model.submit()
    async let b: Void = model.submit()  // double tap
    _ = await (a, b)
    XCTAssertEqual(t.requests(.post, "/reservations").count, 1)
    XCTAssertEqual(model.successMessage, "予約を申請しました。担当講師の承認をお待ちください。")
    XCTAssertFalse(model.successMessage!.contains("確定"))
    await model.submit()
    XCTAssertEqual(t.requests(.post, "/reservations").count, 1)
    XCTAssertEqual(model.timeLabel, "14:00–15:30")
    XCTAssertEqual(model.dateLabel, "10月5日（月）")
    XCTAssertEqual(model.cancelPolicyText, "取消期限は、授業開始の24時間前です。")
  }

  func testLostResponseIsVerifiedByIdempotencyKey() async {
    let t = MockTransport()
    t.on(.post, "/reservations", error: .timedOut)
    t.on(.get, "/reservations", json: Fixtures.page([Fixtures.reservationJSON()]))
    let model = BookingConfirmModel(slot: Fixtures.slot(), context: makeContext(t))
    await model.submit()
    let posts = t.requests(.post, "/reservations")
    XCTAssertEqual(posts.count, 3, "automatic retries reuse the key")
    XCTAssertEqual(Set(posts.compactMap { $0.header("Idempotency-Key") }).count, 1)
    let lookup = t.requests(.get, "/reservations").first
    XCTAssertTrue(lookup?.url.query?.contains("idempotency_key=\(model.idempotencyKey.value)") ?? false)
    XCTAssertNotNil(model.successMessage)
    XCTAssertNil(model.error)
  }

  func testBusinessErrorShownAndNewKeyForNextAttempt() async {
    let t = MockTransport()
    t.on(.post, "/reservations", status: 409, json: Fixtures.errorJSON("SLOT_FULL", "この授業は満席です。"))
    let model = BookingConfirmModel(slot: Fixtures.slot(), context: makeContext(t))
    let firstKey = model.idempotencyKey
    await model.submit()
    XCTAssertEqual(model.error?.messageJa, "この授業は満席です。")
    XCTAssertNil(model.successMessage)
    XCTAssertNotEqual(model.idempotencyKey, firstKey)
  }

  func testOfflineBlocksMutation() async {
    let t = MockTransport()
    let context = makeContext(t)
    context.setOnline(false)
    let model = BookingConfirmModel(slot: Fixtures.slot(), context: context)
    XCTAssertFalse(model.canSubmit)
    await model.submit()
    XCTAssertTrue(t.requests.isEmpty)
    XCTAssertEqual(model.error?.messageJa, AppContext.offlineMutationMessage)
  }

  func testMyReservationsOrdering() async {
    let t = MockTransport()
    t.on(
      .get, "/reservations",
      json: Fixtures.page([
        Fixtures.reservationJSON(id: "past", status: "approved", startsAt: "2026-09-01T01:00:00Z", endsAt: "2026-09-01T02:00:00Z"),
        Fixtures.reservationJSON(id: "later", status: "approved", startsAt: "2026-10-07T07:00:00Z", endsAt: "2026-10-07T08:00:00Z"),
        Fixtures.reservationJSON(id: "soon"),
        Fixtures.reservationJSON(id: "gone", status: "removed"),
      ]))
    let model = MyReservationsModel(context: makeContext(t))
    await model.load()
    XCTAssertEqual(model.items.map(\.id), ["soon", "later", "past"])
  }

  func testCancelSendsExpectedVersionAndHandlesConflict() async {
    let t = MockTransport()
    t.on(.get, "/reservations/\(Fixtures.reservationId)", json: Fixtures.reservationJSON(status: "approved", rowVersion: 2))
    t.on(.post, "/reservations/\(Fixtures.reservationId)/cancel", json: Fixtures.reservationJSON(status: "cancelled", rowVersion: 3))
    let model = ReservationDetailModel(reservationId: Fixtures.reservationId, context: makeContext(t))
    await model.load()
    XCTAssertTrue(model.canCancel)
    await model.cancel(reason: "  ")
    let request = t.requests(.post, "/reservations/\(Fixtures.reservationId)/cancel").first
    XCTAssertEqual(body(request!)?["expected_version"], 2)
    XCTAssertNil(body(request!)?["reason"])
    XCTAssertNotNil(request?.header("Idempotency-Key"))
    XCTAssertEqual(model.reservation.value?.status, .cancelled)
    XCTAssertEqual(model.actionMessage, "予約を取り消しました。")
    XCTAssertFalse(model.canCancel)

    let t2 = MockTransport()
    t2.on(.get, "/reservations/\(Fixtures.reservationId)", json: Fixtures.reservationJSON(status: "approved", rowVersion: 5))
    t2.on(.post, "/reservations/\(Fixtures.reservationId)/cancel", status: 409, json: Fixtures.errorJSON("VERSION_CONFLICT", "情報が更新されました。再読み込みしてください。"))
    let m2 = ReservationDetailModel(reservationId: Fixtures.reservationId, context: makeContext(t2))
    await m2.load()
    await m2.cancel(reason: nil)
    XCTAssertEqual(m2.actionError?.messageJa, "情報が更新されました。再読み込みしてください。")
    XCTAssertEqual(t2.requests(.get, "/reservations/\(Fixtures.reservationId)").count, 2, "reloaded after conflict")
  }

  func testTeacherCannotCancelAndDeadlineHidesCancel() async {
    let t = MockTransport()
    t.on(.get, "/reservations/\(Fixtures.reservationId)", json: Fixtures.reservationJSON(status: "approved"))
    let teacherModel = ReservationDetailModel(reservationId: Fixtures.reservationId, context: makeContext(t, me: Fixtures.teacherMe))
    await teacherModel.load()
    XCTAssertFalse(teacherModel.canCancel)
    let clock = TestClock(ISO8601.parse("2026-10-04T05:00:01Z")!)
    let late = ReservationDetailModel(reservationId: Fixtures.reservationId, context: makeContext(t, clock: clock))
    await late.load()
    XCTAssertFalse(late.canCancel)
  }

  func testTeacherApproveAndRejectWithReason() async {
    let t = MockTransport()
    t.on(
      .get, "/reservations",
      json: Fixtures.page([
        Fixtures.reservationJSON(id: "r1"),
        Fixtures.reservationJSON(id: "r2", studentName: "鈴木 大輔"),
        Fixtures.reservationJSON(id: "r3", status: "approved"),
      ]))
    t.on(.post, "/reservations/r1/approve", json: Fixtures.reservationJSON(id: "r1", status: "approved", rowVersion: 2))
    t.on(.post, "/reservations/r2/reject", json: Fixtures.reservationJSON(id: "r2", status: "rejected", studentName: "鈴木 大輔", rowVersion: 2, reason: #""日程変更""#))
    let model = TeacherReservationsModel(context: makeContext(t, me: Fixtures.teacherMe))
    await model.load()
    XCTAssertEqual(model.items.map(\.id), ["r1", "r2"])
    model.filter = .all
    XCTAssertEqual(model.items.count, 3)
    model.filter = .pending

    await model.approve(model.items[0])
    XCTAssertEqual(body(t.requests(.post, "/reservations/r1/approve")[0])?["expected_version"], 1)
    XCTAssertEqual(model.actionMessage, "和田 一夫さんの予約を承認しました。")
    XCTAssertEqual(model.items.map(\.id), ["r2"])

    let r2 = model.items[0]
    let validation = await model.reject(r2, reason: "   ")
    XCTAssertEqual(validation, "却下の理由を入力してください。")
    XCTAssertTrue(t.requests(.post, "/reservations/r2/reject").isEmpty)
    let ok = await model.reject(r2, reason: " 日程変更 ")
    XCTAssertNil(ok)
    XCTAssertEqual(body(t.requests(.post, "/reservations/r2/reject")[0])?["reason"], "日程変更")
    XCTAssertEqual(model.actionMessage, "鈴木 大輔さんの予約を却下しました。")
  }

  static func rosterJSON(editable: Bool = true, state: String = "open", wadaState: String = "null") -> String {
    #"""
    {"data":{"slot_id":"\#(Fixtures.slotId)","slot_title":"IT基礎・セキュリティ","starts_at":"2026-10-05T05:00:00.000Z","ends_at":"2026-10-05T06:30:00.000Z",
    "state":"\#(state)","editable":\#(editable),"items":[
    {"student_id":"s-wada","student_name":"和田 一夫","employee_number":"E001","reservation_id":"a","reservation_status":"approved","attendance_state":\#(wadaState),"note":"","recorded_by_name":null,"recorded_at":null},
    {"student_id":"s-suzuki","student_name":"鈴木 大輔","employee_number":"E002","reservation_id":"c","reservation_status":"approved","attendance_state":null,"note":"","recorded_by_name":null,"recorded_at":null}]},
    "checked_at":"2026-10-05T04:40:00.000Z"}
    """#
  }

  func testAttendanceRosterAndSave() async {
    let t = MockTransport()
    t.on(.get, "/lesson-slots/\(Fixtures.slotId)/attendance", json: Self.rosterJSON())
    t.on(.post, "/lesson-slots/\(Fixtures.slotId)/attendance", json: #"{"id":"\#(Fixtures.slotId)","data":{"slot_id":"\#(Fixtures.slotId)","records":[]},"checked_at":"2026-10-02T02:00:00Z"}"#)
    let model = AttendanceModel(slot: Fixtures.slot(), context: makeContext(t, me: Fixtures.teacherMe))
    await model.load()
    XCTAssertEqual(model.draft.rows.map(\.studentId), ["s-wada", "s-suzuki"])
    XCTAssertTrue(model.isEditable)
    XCTAssertNil(model.notEditableMessage)
    XCTAssertEqual(model.subtitle, "10月5日（月）14:00–15:30 / 新入社員Aクラス")
    model.setState(.absent, for: "s-wada")
    model.setNote("体調不良", for: "s-wada")
    XCTAssertTrue(model.isDirty)
    await model.load()
    XCTAssertEqual(model.draft.rows[0].state, .absent, "a refresh keeps unsaved edits")
    // After saving, the server roster (now recorded) is shown.
    t.on(.get, "/lesson-slots/\(Fixtures.slotId)/attendance", json: Self.rosterJSON(wadaState: #""absent""#))
    await model.save()
    let sent = body(t.requests(.post, "/lesson-slots/\(Fixtures.slotId)/attendance")[0])
    let records = sent?["records"]?.arrayValue ?? []
    XCTAssertEqual(records.count, 2)
    XCTAssertTrue(records.contains { $0["student_id"] == "s-wada" && $0["state"] == "absent" && $0["note"] == "体調不良" })
    XCTAssertEqual(model.savedMessage, "出欠を保存しました（2名）。")
    XCTAssertFalse(model.isDirty)
    XCTAssertEqual(model.draft.rows[0].state, .absent)
  }

  func testAttendanceNotOpenIsReadOnlyAndHandled() async {
    let t = MockTransport()
    t.on(.get, "/lesson-slots/\(Fixtures.slotId)/attendance", json: Self.rosterJSON(editable: false))
    t.on(
      .post, "/lesson-slots/\(Fixtures.slotId)/attendance", status: 409,
      json: Fixtures.errorJSON("ATTENDANCE_NOT_OPEN", "出欠は授業開始の30分前から記録できます。"))
    let model = AttendanceModel(slotId: Fixtures.slotId, context: makeContext(t, me: Fixtures.teacherMe))
    await model.load()
    XCTAssertEqual(model.title, "IT基礎・セキュリティ")
    XCTAssertFalse(model.canSave)
    XCTAssertEqual(model.notEditableMessage, "出欠は授業開始の30分前から記録できます。")
    await model.save()  // e.g. the clock moved; the server still refuses
    XCTAssertEqual(model.error?.code, "ATTENDANCE_NOT_OPEN")
    XCTAssertEqual(t.requests(.get, "/lesson-slots/\(Fixtures.slotId)/attendance").count, 2, "roster reloaded")

    t.on(.get, "/lesson-slots/\(Fixtures.slotId)/attendance", json: Self.rosterJSON(editable: false, state: "cancelled"))
    await model.load()
    XCTAssertEqual(model.notEditableMessage, "この授業枠は取り消されています。")
  }
}

@MainActor
final class LearningModelTests: XCTestCase {
  static let noStatus =
    #"{"confirmed_at":null,"quiz_attempts_used":null,"quiz_score":null,"quiz_passed":null,"submission_state":null,"feedback":null}"#

  let materialsPage = Fixtures.page([
    Fixtures.materialJSON(id: "m1", title: "基本ガイド.pdf", kind: "pdf", learner: LearningModelTests.noStatus),
    Fixtures.materialJSON(
      id: "m2", title: "検査中.pdf", kind: "pdf", scanState: "pending", published: false, learner: LearningModelTests.noStatus),
    Fixtures.materialJSON(
      id: "m3", title: "確認テスト", kind: "quiz", scanState: "not_applicable", sizeBytes: "null", questionCount: "5",
      learner: #"{"confirmed_at":null,"quiz_attempts_used":2,"quiz_score":60,"quiz_passed":false,"submission_state":null,"feedback":null}"#),
    Fixtures.materialJSON(
      id: "m5", title: "社内ポータル", kind: "link", scanState: "not_applicable", sizeBytes: "null",
      externalUrl: #""https://portal.example.invalid/guide""#,
      learner: #"{"confirmed_at":"2026-10-01T01:00:00.000Z","quiz_attempts_used":null,"quiz_score":null,"quiz_passed":null,"submission_state":null,"feedback":null}"#),
  ])

  func testMaterialsVisibilityDownloadAndReceipt() async {
    let t = MockTransport()
    t.on(.get, "/units/\(Fixtures.unitId)/materials", json: materialsPage)
    t.on(
      .get, "/materials/m1/download",
      json: #"{"data":{"url":"https://files.example.invalid/m1?sig=x","expires_at":"2026-10-02T02:05:00Z","content_type":"application/pdf"},"checked_at":"2026-10-02T02:00:00Z"}"#)
    t.on(.post, "/materials/m1/receipt", json: Fixtures.actionJSON(#"{"material_id":"m1","confirmed_at":"2026-10-02T02:00:00.000Z","unit_state":"in_progress"}"#))
    let model = UnitMaterialsModel(unitId: Fixtures.unitId, unitTitle: "IT基礎", context: makeContext(t))
    await model.load()
    XCTAssertEqual(model.visibleMaterials.map(\.id), ["m1", "m3", "m5"])
    let download = await model.downloadURL(for: model.visibleMaterials[0])
    XCTAssertEqual(download?.contentType, "application/pdf")
    XCTAssertEqual(model.learnerStatusText(model.visibleMaterials[0]), nil)
    await model.confirmReceipt(model.visibleMaterials[0])
    await model.confirmReceipt(model.visibleMaterials[0])
    XCTAssertEqual(t.requests(.post, "/materials/m1/receipt").count, 1)
    XCTAssertTrue(model.receivedIds.contains("m1"))
    XCTAssertEqual(model.actionMessage, "「基本ガイド.pdf」の確認を記録しました。")
    XCTAssertEqual(model.learnerStatusText(model.visibleMaterials[0]), "確認済み")
    // Learner status from the server.
    XCTAssertEqual(model.learnerStatusText(model.visibleMaterials[1]), "テスト60点・不合格（受験2回）")
    let link = model.visibleMaterials[2]
    XCTAssertTrue(model.isConfirmed(link))
    XCTAssertEqual(model.learnerStatusText(link), "確認済み（10月1日（木））")
    // Link materials open their https URL without a download round trip; confirmed ones are not re-sent.
    let linkTarget = await model.downloadURL(for: link)
    XCTAssertEqual(linkTarget?.url, "https://portal.example.invalid/guide")
    XCTAssertTrue(t.requests(.get, "/materials/m5/download").isEmpty)
    await model.confirmReceipt(link)
    XCTAssertTrue(t.requests(.post, "/materials/m5/receipt").isEmpty)
  }

  func testDownloadErrorsUseServerMessages() async {
    let t = MockTransport()
    t.on(.get, "/materials/m1/download", status: 409, json: Fixtures.errorJSON("SCAN_PENDING", "ファイル検査が完了していないため公開できません。"))
    let model = UnitMaterialsModel(unitId: Fixtures.unitId, unitTitle: "IT基礎", context: makeContext(t))
    let m = Material(id: "m1", unitId: Fixtures.unitId, title: "x", kind: .pdf, required: true, scanState: .clean, published: true, sizeBytes: 1, rowVersion: 1)
    let download = await model.downloadURL(for: m)
    XCTAssertNil(download)
    XCTAssertEqual(model.actionError?.code, "SCAN_PENDING")
  }

  func testInsecureDownloadURLIsRejected() async {
    let t = MockTransport()
    t.on(
      .get, "/materials/m1/download",
      json: #"{"data":{"url":"http://files.example.invalid/m1","expires_at":"2026-10-02T02:05:00Z","content_type":"application/pdf"},"checked_at":"2026-10-02T02:00:00Z"}"#)
    let model = UnitMaterialsModel(unitId: Fixtures.unitId, unitTitle: "IT基礎", context: makeContext(t))
    let m = Material(id: "m1", unitId: Fixtures.unitId, title: "x", kind: .pdf, required: true, scanState: .clean, published: true, sizeBytes: 1, rowVersion: 1)
    let download = await model.downloadURL(for: m)
    XCTAssertNil(download)
    XCTAssertEqual(model.actionError?.code, "INVALID_URL")
  }

  func testQuizIsServerScored() async {
    let t = MockTransport()
    t.on(
      .get, "/materials/m3/quiz",
      json: #"{"data":{"id":"q","title":"確認テスト","questions":[{"id":"q1","prompt":"Q1","choices":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}],"attempts_used":1,"attempts_remaining":2,"pass_score":80,"max_attempts":3,"score_policy":"highest","total_points":1,"effective_score":0,"passed":false},"checked_at":"2026-10-02T02:00:00Z"}"#)
    t.on(.post, "/materials/m3/quiz-attempts", json: #"{"data":{"id":"att","score":0,"passed":false,"submitted_at":"2026-10-02T02:01:00Z","attempts_used":2,"attempts_remaining":1,"pass_score":80,"effective_score":0,"correct_count":0,"question_count":1},"checked_at":"2026-10-02T02:01:00Z"}"#)
    let material = Material(id: "m3", unitId: Fixtures.unitId, title: "確認テスト", kind: .quiz, required: true, scanState: .notApplicable, published: true, sizeBytes: nil, rowVersion: 1)
    let model = QuizModel(material: material, context: makeContext(t))
    await model.load()
    XCTAssertFalse(model.canSubmit)
    model.select("b", for: "q1")
    XCTAssertTrue(model.canSubmit)
    await model.submit()
    await model.submit()
    XCTAssertEqual(t.requests(.post, "/materials/m3/quiz-attempts").count, 1)
    XCTAssertEqual(body(t.requests(.post, "/materials/m3/quiz-attempts")[0]), ["answers": [["question_id": "q1", "selected_option_ids": ["b"]]]])
    XCTAssertEqual(model.resultText, "0点・不合格")
    XCTAssertEqual(model.resultDetail, "1問中0問正解 / 合格点80点")
    XCTAssertEqual(model.resultPolicyText, "進捗に反映される点数：0点（残り1回受験できます）")
    XCTAssertTrue(model.canRetry, "the server still allows an attempt")
  }

  func testAssignmentSubmission() async {
    let t = MockTransport()
    t.on(.post, "/materials/m4/submissions", json: #"{"data":\#(Fixtures.submissionJSON(id: "s1", body: "業務改善の提案")),"checked_at":"2026-10-02T02:00:00Z"}"#)
    let material = Material(id: "m4", unitId: Fixtures.unitId, title: "実践課題", kind: .assignment, required: true, scanState: .notApplicable, published: true, sizeBytes: nil, rowVersion: 1)
    let model = AssignmentModel(material: material, context: makeContext(t))
    await model.submit()
    XCTAssertEqual(model.error?.fieldErrors["body"], "提出内容を入力してください。")
    model.body = "  業務改善の提案  "
    await model.submit()
    XCTAssertEqual(body(t.requests(.post, "/materials/m4/submissions")[0]), ["body": "業務改善の提案"])
    XCTAssertEqual(model.successMessage, "提出しました（提出済み（確認待ち））。講師の評価をお待ちください。")
  }

  /// POST /uploads → presigned PUT (required_headers) → POST /uploads/{id}/complete → submit with object_key.
  func testAssignmentWithFileUsesUploadFlow() async {
    let t = MockTransport()
    let putURL = "https://r2.example.invalid/arms/quarantine/org/k1?X-Amz-Signature=abc"
    t.on(
      .post, "/uploads",
      json: #"{"data":{"id":"up1","upload_url":"\#(putURL)","object_key":"quarantine/org/k1","expires_at":"2026-10-02T02:15:00.000Z","required_headers":{"Content-Type":"application/pdf"}},"checked_at":"2026-10-02T02:00:00.000Z"}"#)
    t.on(.put, putURL) { _, _ in HTTPResponse(status: 200) }
    t.on(
      .post, "/uploads/up1/complete",
      json: Fixtures.actionJSON(#"{"id":"up1","purpose":"assignment","filename":"report.pdf","content_type":"application/pdf","size_bytes":4,"state":"scanning","scan_state":"pending","object_key":"quarantine/org/k1","created_at":"2026-10-02T02:00:00.000Z","completed_at":"2026-10-02T02:00:01.000Z","reject_code":null,"scanner_configured":true}"#))
    t.on(.post, "/materials/m4/submissions", json: #"{"data":\#(Fixtures.submissionJSON(id: "s1", body: "", hasFile: true, scanState: "pending")),"checked_at":"2026-10-02T02:00:02Z"}"#)
    let material = Material(id: "m4", unitId: Fixtures.unitId, title: "実践課題", kind: .assignment, required: true, scanState: .notApplicable, published: true, sizeBytes: nil, rowVersion: 1)
    let model = AssignmentModel(material: material, context: makeContext(t))
    XCTAssertEqual(model.attach(filename: "report.docx", contentType: "application/msword", data: Data("x".utf8)), "添付できるファイルはPDF・PNG・JPEGです。")
    XCTAssertNil(model.attachment)
    XCTAssertNil(model.attach(filename: "report.pdf", contentType: "application/pdf", data: Data("%PDF".utf8)))
    await model.submit()
    XCTAssertNil(model.error)
    XCTAssertEqual(body(t.requests(.post, "/uploads")[0]), ["filename": "report.pdf", "content_type": "application/pdf", "size_bytes": 4, "purpose": "assignment"])
    XCTAssertNotNil(t.requests(.post, "/uploads")[0].header("Idempotency-Key"))
    let put = t.requests.first { $0.method == .put }
    XCTAssertEqual(put?.url.absoluteString, putURL)
    XCTAssertEqual(put?.header("Content-Type"), "application/pdf")
    XCTAssertNil(put?.header("Authorization"), "the presigned URL is the credential")
    XCTAssertEqual(put?.body, Data("%PDF".utf8))
    XCTAssertEqual(t.requests(.post, "/uploads/up1/complete").count, 1)
    XCTAssertEqual(body(t.requests(.post, "/materials/m4/submissions")[0]), ["body": "", "object_key": "quarantine/org/k1"])
    XCTAssertEqual(model.successMessage, "提出しました（ファイル添付あり）（提出済み（確認待ち））。講師の評価をお待ちください。")
  }

  func testRejectedUploadIsNotSubmitted() async {
    let t = MockTransport()
    let putURL = "https://r2.example.invalid/arms/quarantine/org/k2?sig=1"
    t.on(
      .post, "/uploads",
      json: #"{"data":{"id":"up2","upload_url":"\#(putURL)","object_key":"quarantine/org/k2","expires_at":"2026-10-02T02:15:00.000Z","required_headers":{"Content-Type":"image/png"}},"checked_at":"2026-10-02T02:00:00.000Z"}"#)
    t.on(.put, putURL) { _, _ in HTTPResponse(status: 200) }
    t.on(.post, "/uploads/up2/complete", status: 422, json: Fixtures.errorJSON("FILE_REJECTED", "ファイルの形式または内容が許可されていません。"))
    let material = Material(id: "m4", unitId: Fixtures.unitId, title: "実践課題", kind: .assignment, required: true, scanState: .notApplicable, published: true, sizeBytes: nil, rowVersion: 1)
    let model = AssignmentModel(material: material, context: makeContext(t))
    model.attach(filename: "photo.png", contentType: "image/png", data: Data([0x00]))
    await model.submit()
    XCTAssertEqual(model.error?.code, "FILE_REJECTED")
    XCTAssertTrue(t.requests(.post, "/materials/m4/submissions").isEmpty)
    XCTAssertEqual(model.phase, .idle)
  }

  func testAssignmentBlockedWhileAwaitingReview() {
    let material = Material(
      id: "m4", unitId: Fixtures.unitId, title: "実践課題", kind: .assignment, required: true, scanState: .notApplicable,
      published: true, sizeBytes: nil, rowVersion: 1,
      learnerStatus: LearnerStatus(submissionState: .revisionRequested, feedback: "具体例を追加してください"))
    let model = AssignmentModel(material: material, context: makeContext(MockTransport()))
    XCTAssertNil(model.blockedReason, "a revision request allows resubmission")
    XCTAssertEqual(model.teacherFeedback, "具体例を追加してください")
    let waiting = AssignmentModel(
      material: Material(
        id: "m4", unitId: Fixtures.unitId, title: "実践課題", kind: .assignment, required: true, scanState: .notApplicable,
        published: true, sizeBytes: nil, rowVersion: 1, learnerStatus: LearnerStatus(submissionState: .submitted)),
      context: makeContext(MockTransport()))
    XCTAssertEqual(waiting.blockedReason, "提出済みの課題は講師の確認待ちです。評価後に再提出できます。")
  }

  func testSubmissionReview() async {
    let t = MockTransport()
    t.on(.post, "/submissions/s1/review", json: #"{"data":\#(Fixtures.submissionJSON(id: "s1", state: "accepted", feedback: #""よくできています""#, rowVersion: 2)),"checked_at":"2026-10-02T02:00:00Z"}"#)
    let submission = Submission(id: "s1", materialId: "m4", studentId: "st", state: .submitted, body: "提案", scanState: .notApplicable, feedback: nil, rowVersion: 1, submittedAt: fixedNow)
    let model = SubmissionReviewModel(submission: submission, context: makeContext(t, me: Fixtures.teacherMe))
    let none = await model.review(.accepted)
    XCTAssertNil(none)
    XCTAssertEqual(model.error?.fieldErrors["feedback"], "講師コメントを入力してください。")
    model.feedback = "よくできています"
    let reviewed = await model.review(.accepted)
    XCTAssertEqual(reviewed?.state, .accepted)
    XCTAssertEqual(body(t.requests[0]), ["state": "accepted", "feedback": "よくできています", "expected_version": 1])
    XCTAssertEqual(model.successMessage, "合格として評価しました。")
  }

  func testSubmissionFileAndConflict() async {
    let t = MockTransport()
    t.on(
      .get, "/submissions/s2/file",
      json: #"{"data":{"url":"https://files.example.invalid/s2?sig=x","expires_at":"2026-10-02T02:05:00Z","content_type":"application/pdf"},"checked_at":"2026-10-02T02:00:00Z"}"#)
    t.on(.post, "/submissions/s2/review", status: 409, json: Fixtures.errorJSON("VERSION_CONFLICT", "情報が更新されました。再読み込みしてください。"))
    let submission = try! ARMSJSON.decoder.decode(
      Submission.self, from: Data(Fixtures.submissionJSON(id: "s2", hasFile: true, scanState: "clean").utf8))
    let model = SubmissionReviewModel(submission: submission, context: makeContext(t, me: Fixtures.teacherMe))
    XCTAssertEqual(model.heading, "業務改善レポート（実践課題）")
    XCTAssertTrue(model.canOpenFile)
    XCTAssertNil(model.fileStatusText)
    let file = await model.fileURL()
    XCTAssertEqual(file?.contentType, "application/pdf")
    model.feedback = "再提出してください"
    _ = await model.review(.revisionRequested)
    _ = await model.review(.revisionRequested)
    let keys = t.requests(.post, "/submissions/s2/review").compactMap { $0.header("Idempotency-Key") }
    XCTAssertEqual(keys.count, 2)
    XCTAssertNotEqual(keys[0], keys[1], "a definitive conflict ends the action")
    XCTAssertEqual(model.error?.code, "VERSION_CONFLICT")

    let pending = SubmissionReviewModel(
      submission: try! ARMSJSON.decoder.decode(
        Submission.self, from: Data(Fixtures.submissionJSON(id: "s3", hasFile: true, scanState: "pending").utf8)),
      context: makeContext(t, me: Fixtures.teacherMe))
    XCTAssertFalse(pending.canOpenFile)
    XCTAssertEqual(pending.fileStatusText, "添付ファイルはウイルス検査中です。検査完了後に確認できます。")
  }
}

@MainActor
final class HomeAndAccountModelTests: XCTestCase {
  func testStudentHomeLoadsProgressLessonsAndBadge() async {
    let t = MockTransport()
    t.on(.get, "/students/\(Fixtures.studentId)/progress", json: Fixtures.progressJSON())
    t.on(.get, "/today-lessons", json: Fixtures.page([Fixtures.slotJSON(title: "IT基礎", startsAt: "2026-10-02T05:00:00Z", endsAt: "2026-10-02T06:30:00Z"), Fixtures.slotJSON(id: "x", title: "ビジネスマナー", startsAt: "2026-10-02T01:00:00Z", endsAt: "2026-10-02T02:30:00Z")]))
    t.on(.get, "/notifications", json: Fixtures.page([
      #"{"id":"n1","title":"t","body":"b","deep_link":"arms://notifications","read_at":null,"created_at":"2026-10-02T01:00:00Z"}"#,
      #"{"id":"n2","title":"t","body":"b","deep_link":"arms://notifications","read_at":"2026-10-02T01:30:00Z","created_at":"2026-10-02T01:00:00Z"}"#,
    ]))
    let context = makeContext(t)
    let model = StudentHomeModel(context: context)
    await model.load()
    XCTAssertEqual(model.summary?.percentText, "76%")
    XCTAssertEqual(model.lessons.map(\.title), ["ビジネスマナー", "IT基礎"])
    XCTAssertEqual(model.greeting, "こんにちは、\n和田さん。")  // 11:00 JST
    XCTAssertEqual(model.dateLabel, "2026年10月2日（金）")
    XCTAssertEqual(context.unreadNotifications, 1)
  }

  func testTeacherHomeCounts() async {
    let t = MockTransport()
    let studentItem = { (id: String, active: Bool) in
      #"{"id":"\#(id)","employee_number":"E","display_name":"A","kana":"","email":"a@example.invalid","company_name":"","department_name":"開発部","joined_on":"2026-10-01","classroom_id":"c","teacher_id":"t","training_starts_on":"2026-10-01","training_due_on":"2026-12-31","active":\#(active),"row_version":1,"progress_percent":null}"#
    }
    t.on(.get, "/today-lessons", json: Fixtures.page([Fixtures.slotJSON()]))
    t.on(.get, "/students", json: Fixtures.page([studentItem("s1", true), studentItem("s2", true), studentItem("s3", false)]))
    t.on(.get, "/reservations", json: Fixtures.page([Fixtures.reservationJSON(id: "p1"), Fixtures.reservationJSON(id: "p2", expiresAt: "2026-10-01T00:00:00Z")]))
    t.on(.get, "/submissions", status: 404, json: Fixtures.errorJSON("NOT_FOUND", "対象が見つかりません。"))
    t.on(.get, "/notifications", json: Fixtures.page([]))
    let model = TeacherHomeModel(context: makeContext(t, me: Fixtures.teacherMe))
    await model.load()
    XCTAssertEqual(model.counts.value?.students, 2)
    XCTAssertEqual(model.counts.value?.pendingReservations, 1, "expired pending requests are not counted")
    XCTAssertNil(model.counts.value?.pendingReviews, "hidden when the review queue is unavailable")
    XCTAssertEqual(model.greeting, "田中先生、\n本日もよろしくお願いします。")
    XCTAssertTrue(t.requests(.get, "/reservations")[0].url.query?.contains("status=pending") ?? false)
  }

  func testTeacherStudentsRowsAndFilter() async {
    let t = MockTransport()
    t.on(.get, "/classrooms", json: Fixtures.page([#"{"id":"\#(Fixtures.classroomId)","name":"新入社員Aクラス","capacity":30,"starts_on":"2026-10-01","ends_on":"2026-12-31","primary_teacher_id":"\#(Fixtures.teacherId)","assistant_teacher_ids":[],"program_version_ids":[],"student_count":24,"archived":false,"row_version":1}"#]))
    t.on(.get, "/teachers", json: Fixtures.page([]))
    t.on(.get, "/students", json: Fixtures.page([#"{"id":"s1","employee_number":"E001","display_name":"中村 翔太","kana":"","email":"n@example.invalid","company_name":"","department_name":"開発部","joined_on":"2026-10-01","classroom_id":"\#(Fixtures.classroomId)","teacher_id":"\#(Fixtures.teacherId)","training_starts_on":"2026-09-01","training_due_on":"2026-10-01","active":true,"row_version":1,"progress_percent":42}"#], next: "n"))
    let model = TeacherStudentsModel(context: makeContext(t, me: Fixtures.teacherMe))
    model.searchText = "中村"
    model.classroomId = Fixtures.classroomId
    await model.load()
    let query = t.requests(.get, "/students")[0].url.query ?? ""
    XCTAssertTrue(query.contains("classroom_id=\(Fixtures.classroomId)"))
    XCTAssertTrue(query.removingPercentEncoding?.contains("q=中村") ?? false)
    XCTAssertEqual(model.rows.first?.status, .overdue)
    XCTAssertEqual(model.rows.first?.classroomName, "新入社員Aクラス")
    XCTAssertEqual(model.rows.first?.teacherName, "田中 祥司")
    XCTAssertEqual(model.selectedClassroomName, "新入社員Aクラス")
    XCTAssertTrue(model.canLoadMore)
  }

  func testStudentDetailReviewQueueFiltersToStudent() async {
    let t = MockTransport()
    t.on(.get, "/students/s1", json: #"{"data":{"id":"s1","employee_number":"E001","display_name":"和田 一夫","kana":"","email":"w@example.invalid","company_name":"","department_name":"開発部","joined_on":"2026-10-01","classroom_id":"c","teacher_id":"t","training_starts_on":"2026-10-01","training_due_on":"2026-12-31","active":true,"row_version":1,"progress_percent":76},"checked_at":"2026-10-02T02:00:00Z"}"#)
    t.on(.get, "/students/s1/progress", json: Fixtures.progressJSON())
    t.on(.get, "/submissions", json: Fixtures.page([
      Fixtures.submissionJSON(id: "sub1", studentId: "s1"),
      Fixtures.submissionJSON(id: "sub2", studentId: "other", body: "x"),
      Fixtures.submissionJSON(id: "sub3", studentId: "s1", state: "accepted", body: "y", feedback: #""ok""#, rowVersion: 2),
    ]))
    let model = StudentDetailModel(studentId: "s1", context: makeContext(t, me: Fixtures.teacherMe))
    await model.load()
    let query = t.requests(.get, "/submissions")[0].url.query ?? ""
    XCTAssertTrue(query.contains("state=submitted") && query.contains("student_id=s1"), query)
    XCTAssertEqual(model.pendingSubmissions.value?.map(\.id), ["sub1"])
    XCTAssertEqual(model.reviewPendingUnits.map(\.title), ["実践課題"])
    model.didReview(model.pendingSubmissions.value![0])
    XCTAssertEqual(model.pendingSubmissions.value?.count, 0)
  }

  func testNotificationsOpenMarksReadAndReturnsDeepLink() async {
    let t = MockTransport()
    t.on(.get, "/notifications", json: Fixtures.page([
      #"{"id":"n1","title":"予約が承認されました","body":"b","deep_link":"arms://reservations/\#(Fixtures.reservationId)","read_at":null,"created_at":"2026-10-02T01:10:00Z"}"#
    ]))
    t.on(.post, "/notifications/n1/read", json: Fixtures.actionJSON())
    let context = makeContext(t)
    let model = NotificationsModel(context: context)
    await model.load()
    XCTAssertEqual(context.unreadNotifications, 1)
    XCTAssertEqual(model.timeLabel(model.items[0]), "10:10")
    let link = await model.open(model.items[0])
    XCTAssertEqual(link, .reservation(id: Fixtures.reservationId))
    XCTAssertTrue(model.items[0].isRead)
    XCTAssertEqual(context.unreadNotifications, 0)
    _ = await model.open(model.items[0])
    XCTAssertEqual(t.requests(.post, "/notifications/n1/read").count, 1)
    // The bell count uses the server's unread filter.
    XCTAssertTrue(t.requests(.get, "/notifications").contains { $0.url.query?.contains("status=unread") ?? false })
  }

  func testNotificationsUnreadFilterAndReadAll() async {
    let t = MockTransport()
    t.on(.get, "/notifications") { request, _ in
      let unreadOnly = request.url.query?.contains("status=unread") ?? false
      let items = [
        #"{"id":"n1","title":"予約が承認されました","body":"b","deep_link":"arms://reservations/\#(Fixtures.reservationId)","read_at":null,"created_at":"2026-10-02T01:10:00Z"}"#,
        #"{"id":"n2","title":"授業が取り消されました","body":"b","deep_link":"arms://lesson-slots/\#(Fixtures.slotId)","read_at":null,"created_at":"2026-10-02T01:00:00Z"}"#,
        #"{"id":"n3","title":"既読","body":"b","deep_link":"arms://lessons/today","read_at":"2026-10-02T01:30:00Z","created_at":"2026-10-01T01:00:00Z"}"#,
      ]
      return HTTPResponse(status: 200, body: Data(Fixtures.page(unreadOnly ? Array(items.prefix(2)) : items).utf8))
    }
    t.on(.post, "/notifications/read-all", json: Fixtures.actionJSON(#"{"updated":2}"#))
    let context = makeContext(t)
    let model = NotificationsModel(context: context)
    await model.load()
    XCTAssertEqual(model.items.count, 3)
    XCTAssertEqual(context.unreadNotifications, 2)
    await model.setFilter(.unread)
    XCTAssertEqual(model.items.map(\.id), ["n1", "n2"])
    XCTAssertTrue(t.requests(.get, "/notifications").last?.url.query?.contains("status=unread") ?? false)
    XCTAssertTrue(model.canMarkAllRead)
    await model.setFilter(.all)
    await model.markAllRead()
    XCTAssertEqual(t.requests(.post, "/notifications/read-all").count, 1)
    XCTAssertTrue(model.items.allSatisfy(\.isRead))
    XCTAssertEqual(context.unreadNotifications, 0)
    XCTAssertEqual(DeepLink.parse(model.items[1].deepLink), .lessonSlot(id: Fixtures.slotId))
  }

  func testSettingsPatchUsesRowVersionAndHandlesConflict() async {
    let t = MockTransport()
    t.on(.patch, "/me/preferences", json: Fixtures.actionJSON(#"{"theme":"dark","notifications_enabled":true,"row_version":1}"#), headers: ["ETag": "\"1\""])
    let context = makeContext(t)
    let model = SettingsModel(context: context)
    XCTAssertEqual(model.accountSubtitle, "受講者 / 新入社員Aクラス")
    await model.setTheme(.dark)
    XCTAssertEqual(t.requests[0].header("If-Match"), "\"0\"")
    XCTAssertEqual(body(t.requests[0]), ["theme": "dark", "notifications_enabled": true])
    XCTAssertEqual(context.me?.preferences.theme, .dark)
    XCTAssertEqual(context.me?.preferences.rowVersion, 1)
    XCTAssertEqual(context.keyValues.string(forKey: StorageKeys.theme), "dark")

    t.on(.patch, "/me/preferences", status: 409, json: Fixtures.errorJSON("VERSION_CONFLICT", "情報が更新されました。再読み込みしてください。"))
    t.on(.get, "/me", json: Fixtures.meJSON(theme: "light", rowVersion: 7))
    await model.setNotificationsEnabled(false)
    XCTAssertEqual(t.requests.last(where: { $0.method == .patch })?.header("If-Match"), "\"1\"")
    XCTAssertEqual(model.error?.code, "VERSION_CONFLICT")
    XCTAssertEqual(context.me?.preferences.rowVersion, 7)
    XCTAssertEqual(context.me?.preferences.theme, .light)
  }

  func testAccountDeletionOnlyReportsServerConfirmedSuccess() async {
    let t = MockTransport()
    t.on(.post, "/me/account-deletion", status: 503, json: Fixtures.errorJSON("DB_UNAVAILABLE", "データベースに接続できません。変更は保存されていません。"))
    let model = SettingsModel(context: makeContext(t))
    await model.requestAccountDeletion(reason: "退職のため")
    XCTAssertFalse(model.deletionRequested)
    XCTAssertEqual(model.error?.code, "DB_UNAVAILABLE")
    let keys = Set(t.requests.compactMap { $0.header("Idempotency-Key") })
    XCTAssertEqual(keys.count, 1)

    t.on(.post, "/me/account-deletion", json: Fixtures.actionJSON(#"{"request_id":"d1","state":"requested"}"#))
    await model.requestAccountDeletion(reason: "退職のため")
    XCTAssertTrue(model.deletionRequested)
    XCTAssertEqual(model.message, "アカウント削除の申請を受け付けました。管理者の確認後に削除され、完了時にお知らせします。")
    XCTAssertEqual(Set(t.requests.compactMap { $0.header("Idempotency-Key") }).count, 1, "same action, same key")
  }

  func testPushRegistrationAndSignOutUnregister() async {
    let t = MockTransport()
    t.on(.post, "/devices", json: Fixtures.actionJSON(#"{"environment":"sandbox"}"#))
    let hash = SHA256Digest.hexDigest("ab01")
    t.on(.delete, "/devices/\(hash)", json: Fixtures.actionJSON(#"{"removed":1}"#))
    let context = makeContext(t)
    let push = PushRegistration(context: context)
    let ok = await push.register(deviceToken: Data([0xab, 0x01]), environment: .sandbox)
    XCTAssertTrue(ok)
    XCTAssertEqual(body(t.requests[0]), ["token": "ab01", "environment": "sandbox"])
    _ = await push.register(deviceToken: Data([0xab, 0x01]), environment: .sandbox)
    XCTAssertEqual(t.requests.count, 1)
    XCTAssertEqual(push.registeredTokenHash, hash)
    // Sign-out: DELETE /devices/{sha256(hex token)} while the session is valid, then forget it.
    let removed = await push.unregister()
    XCTAssertTrue(removed)
    XCTAssertEqual(t.requests.last?.method, .delete)
    XCTAssertEqual(MockTransport.apiPath(t.requests.last!.url), "/devices/\(hash)")
    XCTAssertNil(push.registeredTokenHash)
    let again = await push.unregister()
    XCTAssertTrue(again)
    XCTAssertEqual(t.requests.count, 2, "nothing left to unregister")
  }

  func testPushRegistrationPrefersServerHash() async {
    let t = MockTransport()
    t.on(.post, "/devices", json: Fixtures.actionJSON(#"{"token_hash":"\#(String(repeating: "f", count: 64))","environment":"production"}"#))
    let push = PushRegistration(context: makeContext(t))
    await push.register(deviceToken: Data([0x01]), environment: .production)
    XCTAssertEqual(push.registeredTokenHash, String(repeating: "f", count: 64))
  }

  func testTodayLessonsTags() async {
    let t = MockTransport()
    t.on(.get, "/today-lessons", json: Fixtures.page([Fixtures.slotJSON(myReservation: #"{"id":"r","status":"approved"}"#)]))
    let studentModel = TodayLessonsModel(context: makeContext(t))
    await studentModel.load()
    XCTAssertEqual(studentModel.tag(for: studentModel.lessons[0]).label, "承認済み")
    let teacherModel = TodayLessonsModel(context: makeContext(t, me: Fixtures.teacherMe))
    XCTAssertEqual(teacherModel.tag(for: Fixtures.slot()).label, "担当授業")
  }
}
