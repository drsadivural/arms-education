import ARMSKit
import SwiftUI

/// IOS-07 オンライン予約 (受講者): 空き枠を探す / 自分の予約.
struct BookingView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var router = app.router
    VStack(spacing: 0) {
      Picker("表示", selection: $router.bookingSegment) {
        Text("空き枠を探す").tag(Router.BookingSegment.slots)
        Text("自分の予約").tag(Router.BookingSegment.mine)
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, ARMSMetrics.gutter)
      .padding(.vertical, 12)
      .frame(minHeight: ARMSMetrics.minTapTarget)

      switch router.bookingSegment {
      case .slots:
        ModelHost(make: { BookingModel(context: app.context) }) { model in
          SlotSearchScreen(model: model)
        }
      case .mine:
        MyReservationsView()
      }
    }
    .armsScreen()
    .navigationTitle(router.bookingSegment == .slots ? "オンライン予約" : "自分の予約")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct SlotSearchScreen: View {
  @Environment(AppModel.self) private var app
  let model: BookingModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        MonthCalendarView(model: model)

        Text(model.selectedDateTitle)
          .font(.title3.bold())
          .foregroundStyle(ARMSColor.text)
          .accessibilityAddTraits(.isHeader)

        LoadStateView(
          state: model.slots, isEmpty: { _ in model.slotsForSelectedDate.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "calendar.badge.exclamationmark", title: "この日の空き枠はありません",
              message: "カレンダーで青い印のある日を選んでください。")
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.slotsForSelectedDate) { slot in
              SlotCard(slot: slot) { app.router.push(.bookingConfirm(slot)) }
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

struct MonthCalendarView: View {
  @Environment(AppModel.self) private var app
  let model: BookingModel
  private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

  var body: some View {
    ARMSCard(padding: 14) {
      HStack {
        Button {
          Task { await model.showMonth(model.month.adding(months: -1)) }
        } label: {
          Image(systemName: "chevron.left").frame(width: ARMSMetrics.minTapTarget, height: ARMSMetrics.minTapTarget)
        }
        .disabled(!model.canGoToPreviousMonth)
        .accessibilityLabel("前の月")
        Spacer()
        Text(model.monthTitle).font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        Button {
          Task { await model.showMonth(model.month.adding(months: 1)) }
        } label: {
          Image(systemName: "chevron.right").frame(width: ARMSMetrics.minTapTarget, height: ARMSMetrics.minTapTarget)
        }
        .accessibilityLabel("次の月")
      }
      .foregroundStyle(ARMSColor.primaryText)

      LazyVGrid(columns: columns, spacing: 6) {
        ForEach(Array(MonthGrid.weekdayHeaders.enumerated()), id: \.offset) { index, header in
          Text(header)
            .font(.caption)
            .foregroundStyle(index == 5 ? ARMSColor.primaryText : index == 6 ? ARMSColor.danger : ARMSColor.muted)
            .accessibilityHidden(true)
        }
        ForEach(Array(model.grid.weeks.joined().enumerated()), id: \.offset) { _, day in
          if let day {
            DayCell(day: day, model: model)
          } else {
            Color.clear.frame(height: ARMSMetrics.minTapTarget)
          }
        }
      }
    }
  }
}

private struct DayCell: View {
  let day: LocalDate
  let model: BookingModel

  var body: some View {
    let selected = day == model.selectedDate
    let bookable = model.hasBookableSlots(on: day)
    let isPast = day < model.today
    Button {
      model.select(day)
    } label: {
      VStack(spacing: 2) {
        Text("\(day.day)")
          .font(.subheadline.weight(selected ? .bold : .regular))
          .foregroundStyle(selected ? ARMSColor.onPrimary : (isPast ? ARMSColor.muted : ARMSColor.text))
        Circle()
          .fill(bookable ? (selected ? ARMSColor.onPrimary : ARMSColor.primary) : Color.clear)
          .frame(width: 5, height: 5)
      }
      .frame(maxWidth: .infinity, minHeight: ARMSMetrics.minTapTarget)
      .background(selected ? ARMSColor.primary : Color.clear, in: Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(JaFormat.date(day))\(bookable ? "、空き枠あり" : "")")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

struct SlotCard: View {
  @Environment(AppModel.self) private var app
  let slot: LessonSlot
  let onSelect: () -> Void

  var body: some View {
    let calendar = app.context.calendar
    let availability = SlotRules.availability(slot, now: app.context.now())
    ARMSCard {
      Text(slot.title).font(.headline).foregroundStyle(ARMSColor.text)
      Text(JaFormat.timeRange(slot.startsAt, slot.endsAt, calendar: calendar))
        .font(.title3.weight(.semibold))
        .foregroundStyle(ARMSColor.text)
      Text([slot.teacherName, slot.classroomName, SlotRules.formatLabel(slot)].joined(separator: " / "))
        .font(.subheadline)
        .foregroundStyle(ARMSColor.text)
      HStack {
        StatusTag(
          label: SlotRules.availabilityLabel(availability, remaining: slot.remaining),
          tone: SlotRules.availabilityTone(availability))
        Spacer()
        if availability == .bookable {
          Button(action: onSelect) {
            Text("選択")
              .font(.body.weight(.semibold))
              .foregroundStyle(ARMSColor.onPrimary)
              .frame(minWidth: 72, minHeight: ARMSMetrics.minTapTarget)
              .background(ARMSColor.primary, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius))
          }
          .buttonStyle(.plain)
          .disabled(!app.context.canMutate)
          .accessibilityLabel("\(slot.title) \(JaFormat.timeRange(slot.startsAt, slot.endsAt, calendar: calendar))を選択")
        } else if case .alreadyRequested = availability, let mine = slot.myReservation {
          LinkButton(title: "予約を確認") { app.router.push(.reservation(id: mine.id)) }
        }
      }
    }
  }
}
