import Foundation

public enum ReservationStatus: String, Codable, Sendable, CaseIterable, Hashable {
  case pending
  case approved
  case rejected
  case cancelled
  case expired
  case removed
}

public enum SlotState: String, Codable, Sendable, CaseIterable, Hashable {
  case open
  case closed
  case cancelled
}

/// Contract `LessonSlot` (`GET /lesson-slots`, `GET /today-lessons`).
public struct LessonSlot: Codable, Sendable, Hashable, Identifiable {
  public struct MyReservation: Codable, Sendable, Hashable {
    public let id: String
    public let status: ReservationStatus

    public init(id: String, status: ReservationStatus) {
      self.id = id
      self.status = status
    }
  }

  public let id: String
  public let classroomId: String
  public let teacherId: String
  public let unitId: String?
  public let title: String
  public let startsAt: Date
  public let endsAt: Date
  public let capacity: Int
  public let bookingClosesAt: Date
  /// Only returned to the approved student, the responsible teacher and admins; otherwise nil.
  public let meetingUrl: String?
  public let hasMeetingUrl: Bool
  public let cancelBeforeSeconds: Int
  public let teacherName: String
  public let classroomName: String
  /// Live pending + approved aggregate computed by the server.
  public let remaining: Int
  public let pendingCount: Int?
  public let approvedCount: Int?
  public let state: SlotState
  public let myReservation: MyReservation?
  public let rowVersion: Int

  public init(
    id: String, classroomId: String, teacherId: String, unitId: String?, title: String, startsAt: Date, endsAt: Date,
    capacity: Int, bookingClosesAt: Date, meetingUrl: String?, hasMeetingUrl: Bool, cancelBeforeSeconds: Int,
    teacherName: String, classroomName: String, remaining: Int, pendingCount: Int?, approvedCount: Int?,
    state: SlotState, myReservation: MyReservation?, rowVersion: Int
  ) {
    self.id = id
    self.classroomId = classroomId
    self.teacherId = teacherId
    self.unitId = unitId
    self.title = title
    self.startsAt = startsAt
    self.endsAt = endsAt
    self.capacity = capacity
    self.bookingClosesAt = bookingClosesAt
    self.meetingUrl = meetingUrl
    self.hasMeetingUrl = hasMeetingUrl
    self.cancelBeforeSeconds = cancelBeforeSeconds
    self.teacherName = teacherName
    self.classroomName = classroomName
    self.remaining = remaining
    self.pendingCount = pendingCount
    self.approvedCount = approvedCount
    self.state = state
    self.myReservation = myReservation
    self.rowVersion = rowVersion
  }

  enum CodingKeys: String, CodingKey {
    case id
    case classroomId = "classroom_id"
    case teacherId = "teacher_id"
    case unitId = "unit_id"
    case title
    case startsAt = "starts_at"
    case endsAt = "ends_at"
    case capacity
    case bookingClosesAt = "booking_closes_at"
    case meetingUrl = "meeting_url"
    case hasMeetingUrl = "has_meeting_url"
    case cancelBeforeSeconds = "cancel_before_seconds"
    case teacherName = "teacher_name"
    case classroomName = "classroom_name"
    case remaining
    case pendingCount = "pending_count"
    case approvedCount = "approved_count"
    case state
    case myReservation = "my_reservation"
    case rowVersion = "row_version"
  }
}

/// Contract `Reservation`.
public struct Reservation: Codable, Sendable, Hashable, Identifiable {
  public struct HistoryEntry: Codable, Sendable, Hashable {
    public let eventType: String
    public let status: String?
    public let reason: String?
    public let actorName: String?
    public let createdAt: Date

    public init(eventType: String, status: String?, reason: String?, actorName: String?, createdAt: Date) {
      self.eventType = eventType
      self.status = status
      self.reason = reason
      self.actorName = actorName
      self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
      case eventType = "event_type"
      case status
      case reason
      case actorName = "actor_name"
      case createdAt = "created_at"
    }
  }

  public let id: String
  public let slotId: String
  public let studentId: String
  public let status: ReservationStatus
  public let startsAt: Date
  public let endsAt: Date
  /// Seat-hold deadline of a pending request.
  public let expiresAt: Date
  public let rowVersion: Int
  public let reason: String?
  public let studentName: String?
  public let employeeNumber: String?
  public let slotTitle: String?
  public let teacherId: String?
  public let teacherName: String?
  public let classroomId: String?
  public let classroomName: String?
  /// Only for approved reservations of the student / responsible teacher / admin.
  public let meetingUrl: String?
  public let cancelDeadline: Date?
  public let createdAt: Date?
  public let updatedAt: Date?
  public let history: [HistoryEntry]?
  public let checkedAt: Date

  public init(
    id: String, slotId: String, studentId: String, status: ReservationStatus, startsAt: Date, endsAt: Date,
    expiresAt: Date, rowVersion: Int, reason: String? = nil, studentName: String? = nil,
    employeeNumber: String? = nil, slotTitle: String? = nil, teacherId: String? = nil, teacherName: String? = nil,
    classroomId: String? = nil, classroomName: String? = nil, meetingUrl: String? = nil, cancelDeadline: Date? = nil,
    createdAt: Date? = nil, updatedAt: Date? = nil, history: [HistoryEntry]? = nil, checkedAt: Date
  ) {
    self.id = id
    self.slotId = slotId
    self.studentId = studentId
    self.status = status
    self.startsAt = startsAt
    self.endsAt = endsAt
    self.expiresAt = expiresAt
    self.rowVersion = rowVersion
    self.reason = reason
    self.studentName = studentName
    self.employeeNumber = employeeNumber
    self.slotTitle = slotTitle
    self.teacherId = teacherId
    self.teacherName = teacherName
    self.classroomId = classroomId
    self.classroomName = classroomName
    self.meetingUrl = meetingUrl
    self.cancelDeadline = cancelDeadline
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.history = history
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case id
    case slotId = "slot_id"
    case studentId = "student_id"
    case status
    case startsAt = "starts_at"
    case endsAt = "ends_at"
    case expiresAt = "expires_at"
    case rowVersion = "row_version"
    case reason
    case studentName = "student_name"
    case employeeNumber = "employee_number"
    case slotTitle = "slot_title"
    case teacherId = "teacher_id"
    case teacherName = "teacher_name"
    case classroomId = "classroom_id"
    case classroomName = "classroom_name"
    case meetingUrl = "meeting_url"
    case cancelDeadline = "cancel_deadline"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case history
    case checkedAt = "checked_at"
  }
}

public enum AttendanceState: String, Codable, Sendable, CaseIterable, Hashable {
  case present
  case absent
  case late
  case excused
}

/// Contract `AttendanceRoster` (`GET /lesson-slots/{id}/attendance`, IOS-16): the students holding
/// an approved reservation for the slot plus anyone already recorded, with the current record.
/// `editable` is true from 30 minutes before the start for slots that are not cancelled.
public struct AttendanceRoster: Codable, Sendable, Hashable {
  /// Contract `AttendanceRosterItem`.
  public struct Item: Codable, Sendable, Hashable, Identifiable {
    public let studentId: String
    public let studentName: String
    public let employeeNumber: String
    public let reservationId: String?
    public let reservationStatus: ReservationStatus?
    /// nil until attendance was recorded for the student.
    public let attendanceState: AttendanceState?
    public let note: String
    public let recordedByName: String?
    public let recordedAt: Date?

    public var id: String { studentId }

    public init(
      studentId: String, studentName: String, employeeNumber: String, reservationId: String?,
      reservationStatus: ReservationStatus?, attendanceState: AttendanceState?, note: String, recordedByName: String?,
      recordedAt: Date?
    ) {
      self.studentId = studentId
      self.studentName = studentName
      self.employeeNumber = employeeNumber
      self.reservationId = reservationId
      self.reservationStatus = reservationStatus
      self.attendanceState = attendanceState
      self.note = note
      self.recordedByName = recordedByName
      self.recordedAt = recordedAt
    }

    enum CodingKeys: String, CodingKey {
      case studentId = "student_id"
      case studentName = "student_name"
      case employeeNumber = "employee_number"
      case reservationId = "reservation_id"
      case reservationStatus = "reservation_status"
      case attendanceState = "attendance_state"
      case note
      case recordedByName = "recorded_by_name"
      case recordedAt = "recorded_at"
    }
  }

  public let slotId: String
  public let slotTitle: String
  public let startsAt: Date
  public let endsAt: Date
  public let state: SlotState
  public let editable: Bool
  public let items: [Item]

  public init(
    slotId: String, slotTitle: String, startsAt: Date, endsAt: Date, state: SlotState, editable: Bool, items: [Item]
  ) {
    self.slotId = slotId
    self.slotTitle = slotTitle
    self.startsAt = startsAt
    self.endsAt = endsAt
    self.state = state
    self.editable = editable
    self.items = items
  }

  enum CodingKeys: String, CodingKey {
    case slotId = "slot_id"
    case slotTitle = "slot_title"
    case startsAt = "starts_at"
    case endsAt = "ends_at"
    case state
    case editable
    case items
  }
}
