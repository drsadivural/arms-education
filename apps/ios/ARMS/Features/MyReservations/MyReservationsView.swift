import ARMSKit
import SwiftUI

/// IOS-09 自分の予約: 承認待ち/承認済み/却下/取消済み/申請期限切れ with reasons.
struct MyReservationsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { MyReservationsModel(context: app.context) }) { model in
      MyReservationsScreen(model: model)
    }
  }
}

private struct MyReservationsScreen: View {
  @Environment(AppModel.self) private var app
  let model: MyReservationsModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        LoadStateView(
          state: model.reservations, isEmpty: { _ in model.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "calendar", title: "予約はまだありません", message: "空き枠から授業や面談を申請できます。",
              actionTitle: "空き枠を探す"
            ) { app.router.bookingSegment = .slots }
          }
        ) { _ in
          LazyVStack(spacing: 12) {
            ForEach(model.items) { reservation in
              ReservationCard(reservation: reservation)
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}

private struct ReservationCard: View {
  @Environment(AppModel.self) private var app
  let reservation: Reservation

  var body: some View {
    let now = app.context.now()
    let status = ReservationRules.effectiveStatus(reservation, now: now)
    let calendar = app.context.calendar
    ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Text(reservation.slotTitle ?? "授業").font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: status.labelJa, tone: status.tone)
      }
      Text(JaFormat.dateTimeRange(reservation.startsAt, reservation.endsAt, calendar: calendar))
        .font(.headline)
        .foregroundStyle(ARMSColor.text)
      Text([reservation.teacherName, reservation.classroomName].compactMap { $0 }.joined(separator: " / "))
        .font(.subheadline)
        .foregroundStyle(ARMSColor.text)
      Text(ReservationRules.statusMessage(reservation, now: now))
        .font(.subheadline)
        .foregroundStyle(status == .rejected ? ARMSColor.text : ARMSColor.muted)
      HStack {
        if status == .pending, let created = reservation.createdAt {
          Text("申請：\(JaFormat.shortDateTime(created, calendar: calendar))")
            .font(.footnote)
            .foregroundStyle(ARMSColor.muted)
        }
        Spacer()
        if status == .rejected || status == .expired || status == .cancelled {
          LinkButton(title: "別の枠を探す") { app.router.bookingSegment = .slots }
        } else {
          LinkButton(title: "詳細") { app.router.push(.reservation(id: reservation.id)) }
        }
      }
    }
  }
}
