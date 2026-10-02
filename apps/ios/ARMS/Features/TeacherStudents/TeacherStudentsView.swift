import ARMSKit
import SwiftUI

/// IOS-05 担当受講者の進捗 (teacher scope; out-of-scope students are never returned by the API).
struct TeacherStudentsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { TeacherStudentsModel(context: app.context) }) { model in
      TeacherStudentsScreen(model: model)
    }
    .navigationTitle("担当受講者の進捗")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct TeacherStudentsScreen: View {
  @Environment(AppModel.self) private var app
  @Bindable var model: TeacherStudentsModel
  @State private var searchTask: Task<Void, Never>?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 10) {
          TextField("社員名を検索", text: $model.searchText)
            .textInputAutocapitalization(.never)
            .submitLabel(.search)
            .armsTextField()
            .accessibilityLabel("社員名を検索")
          Menu {
            Button("すべてのクラス") { select(nil) }
            ForEach(model.classrooms) { classroom in
              Button(classroom.name) { select(classroom.id) }
            }
          } label: {
            Text(model.selectedClassroomName)
              .font(.subheadline)
              .lineLimit(1)
              .padding(.horizontal, 14)
              .frame(minHeight: 52)
              .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius))
              .overlay(RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius).strokeBorder(ARMSColor.border))
          }
          .accessibilityLabel("クラスで絞り込み：\(model.selectedClassroomName)")
        }

        LoadStateView(
          state: model.students, isEmpty: { $0.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "person.2", title: "該当する担当受講者はいません",
              message: model.searchText.isEmpty ? nil : "検索条件を変えてお試しください。")
          }
        ) { _ in
          LazyVStack(spacing: 12) {
            ForEach(model.rows) { row in
              StudentRowCard(row: row) { app.router.push(.studentDetail(id: row.student.id)) }
            }
            if model.canLoadMore {
              SecondaryButton(title: "さらに表示", isLoading: model.isLoadingMore) {
                Task { await model.loadMore() }
              }
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
    .onChange(of: model.searchText) { _, _ in
      // Debounced server-side search (q).
      searchTask?.cancel()
      searchTask = Task {
        try? await Task.sleep(nanoseconds: 400_000_000)
        if !Task.isCancelled { await model.load() }
      }
    }
  }

  private func select(_ classroomId: String?) {
    model.classroomId = classroomId
    Task { await model.load() }
  }
}

private struct StudentRowCard: View {
  let row: TeacherStudentsModel.Row
  let onDetail: () -> Void

  var body: some View {
    ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Text(row.student.displayName).font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: row.status.labelJa, tone: row.status.tone)
      }
      Text([row.student.departmentName, row.classroomName].compactMap { $0 }.joined(separator: " · "))
        .font(.subheadline)
        .foregroundStyle(ARMSColor.text)
      LinearProgressBar(
        fraction: row.student.progressPercent.map { Double($0) / 100 },
        label: JaFormat.percent(row.student.progressPercent))
      HStack {
        if let teacher = row.teacherName {
          Text("担当：\(teacher)").font(.footnote).foregroundStyle(ARMSColor.muted)
        }
        Spacer()
        LinkButton(title: "詳細を見る", action: onDetail)
      }
    }
  }
}
