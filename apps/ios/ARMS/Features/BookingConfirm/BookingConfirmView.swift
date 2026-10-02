import ARMSKit
import SwiftUI

/// IOS-08 予約内容の確認: one request per user action (Idempotency-Key reused on retries and
/// double taps). 「申請しました」 is shown only after the server answered 201.
struct BookingConfirmView: View {
  @Environment(AppModel.self) private var app
  let slot: LessonSlot

  var body: some View {
    ModelHost(make: { BookingConfirmModel(slot: slot, context: app.context) }) { model in
      BookingConfirmScreen(model: model)
    }
    .navigationTitle("予約内容の確認")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct BookingConfirmScreen: View {
  @Environment(AppModel.self) private var app
  let model: BookingConfirmModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        InfoNote(text: "申請後、担当講師が確認します。承認されると予約が確定します。")

        ARMSCard {
          Text(model.slot.title).font(.headline).foregroundStyle(ARMSColor.text)
          VStack(spacing: 0) {
            KeyValueRow(label: "日時", value: model.dateLabel)
            KeyValueRow(label: "時間", value: model.timeLabel)
            KeyValueRow(label: "担当講師", value: model.slot.teacherName)
            KeyValueRow(label: "クラス", value: model.slot.classroomName)
            KeyValueRow(label: "形式", value: SlotRules.formatLabel(model.slot))
            KeyValueRow(label: "受講者", value: model.studentName)
          }
        }

        ARMSCard {
          Text("予約申請について").font(.headline).foregroundStyle(ARMSColor.text)
          Text("承認待ちの間も、席の保持期限までは空き枠を確保します。").font(.subheadline).foregroundStyle(ARMSColor.text)
          Text(model.cancelPolicyText).font(.subheadline).foregroundStyle(ARMSColor.text)
        }

        if let error = model.error {
          MessageBanner(kind: .error, text: error.messageWithRequestId)
          if error.code == "ALREADY_RESERVED" {
            // The student already holds a pending/approved request for this lesson.
            LinkButton(title: "自分の予約を確認する") {
              app.router.bookingSegment = .mine
              app.router.bookingPath = []
            }
          }
        }

        if case .submitted(let reservation)? = model.outcome, let message = model.successMessage {
          MessageBanner(kind: .success, text: message)
          PrimaryButton(title: "予約の詳細を見る") {
            app.router.bookingPath = [.reservation(id: reservation.id)]
          }
          SecondaryButton(title: "自分の予約へ") {
            app.router.bookingSegment = .mine
            app.router.bookingPath = []
          }
        } else {
          PrimaryButton(
            title: model.error == nil ? "この内容で予約を申請" : "もう一度申請する",
            isLoading: model.isSubmitting, isEnabled: model.canSubmit && model.error?.code != "ALREADY_RESERVED"
          ) {
            Task { await model.submit() }
          }
          if !app.context.canMutate {
            Text(AppContext.offlineMutationMessage).font(.footnote).foregroundStyle(ARMSColor.danger)
          }
          Text("申請結果は「自分の予約」で確認できます。")
            .font(.footnote)
            .foregroundStyle(ARMSColor.muted)
            .frame(maxWidth: .infinity)
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
  }
}
