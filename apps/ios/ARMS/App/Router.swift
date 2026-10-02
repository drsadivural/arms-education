import ARMSKit
import Observation
import SwiftUI

enum AppTab: Hashable, CaseIterable {
  case home
  case progress
  case booking
  case voice
}

/// In-app destinations pushed on a tab's NavigationStack.
enum Route: Hashable {
  case todayLessons
  case notifications
  case settings
  case studentProgress
  case unitMaterials(unitId: String, title: String)
  case quiz(Material)
  case assignment(Material)
  case reservation(id: String)
  case bookingConfirm(LessonSlot)
  case teacherStudents
  case studentDetail(id: String)
  case attendance(LessonSlot)
  case teacherReservations
}

/// Tab selection, per-tab navigation paths and deep-link handling.
@MainActor
@Observable
final class Router {
  var tab: AppTab = .home
  var homePath: [Route] = []
  var progressPath: [Route] = []
  var bookingPath: [Route] = []
  var voicePath: [Route] = []
  /// Student booking screen segment (空き枠を探す / 自分の予約).
  var bookingSegment: BookingSegment = .slots

  enum BookingSegment: Hashable {
    case slots
    case mine
  }

  func push(_ route: Route) {
    switch tab {
    case .home: homePath.append(route)
    case .progress: progressPath.append(route)
    case .booking: bookingPath.append(route)
    case .voice: voicePath.append(route)
    }
  }

  func popToRoot() {
    switch tab {
    case .home: homePath.removeAll()
    case .progress: progressPath.removeAll()
    case .booking: bookingPath.removeAll()
    case .voice: voicePath.removeAll()
    }
  }

  func reset() {
    tab = .home
    homePath = []
    progressPath = []
    bookingPath = []
    voicePath = []
    bookingSegment = .slots
  }

  /// Opens a deep link (URL scheme, push notification or in-app notification row).
  func open(_ link: DeepLink, role: Role) {
    switch link {
    case .reservation(let id):
      tab = .booking
      bookingPath = [.reservation(id: id)]
    case .reservations:
      tab = .booking
      bookingPath = []
      bookingSegment = .mine
    case .todayLessons:
      tab = .home
      homePath = [.todayLessons]
    case .notifications:
      tab = .home
      homePath = [.notifications]
    case .progress:
      tab = .progress
      progressPath = []
    case .unitMaterials(let unitId):
      tab = role == .student ? .progress : .home
      if role == .student {
        progressPath = [.unitMaterials(unitId: unitId, title: "教材・確認テスト")]
      } else {
        homePath = [.unitMaterials(unitId: unitId, title: "教材・確認テスト")]
      }
    }
  }
}
