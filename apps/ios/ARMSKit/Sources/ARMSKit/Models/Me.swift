import Foundation

public enum Role: String, Codable, Sendable, CaseIterable, Hashable {
  case admin
  case teacher
  case student
}

/// The two usage categories selectable on the iOS login screen (admins must use the Web app).
public enum SelectableRole: String, Codable, Sendable, CaseIterable, Hashable {
  case student
  case teacher

  public var role: Role {
    switch self {
    case .student: return .student
    case .teacher: return .teacher
    }
  }
}

public enum ThemePreference: String, Codable, Sendable, CaseIterable, Hashable {
  case light
  case dark
  case system
}

/// `GET /me` payload (contract `Me`).
public struct Me: Codable, Sendable, Hashable {
  public struct Organization: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let timezone: String

    public init(id: String, name: String, timezone: String) {
      self.id = id
      self.name = name
      self.timezone = timezone
    }
  }

  public struct Preferences: Codable, Sendable, Hashable {
    public var theme: ThemePreference
    public var notificationsEnabled: Bool
    /// Optimistic-concurrency version for `PATCH /me/preferences` (0 = not saved yet).
    public var rowVersion: Int

    public init(theme: ThemePreference, notificationsEnabled: Bool, rowVersion: Int) {
      self.theme = theme
      self.notificationsEnabled = notificationsEnabled
      self.rowVersion = rowVersion
    }

    enum CodingKeys: String, CodingKey {
      case theme
      case notificationsEnabled = "notifications_enabled"
      case rowVersion = "row_version"
    }
  }

  public struct StudentAffiliation: Codable, Sendable, Hashable {
    public let employeeNumber: String
    public let classroomId: String
    public let classroomName: String
    public let teacherId: String
    public let teacherName: String
    public let departmentName: String

    public init(
      employeeNumber: String, classroomId: String, classroomName: String, teacherId: String, teacherName: String,
      departmentName: String
    ) {
      self.employeeNumber = employeeNumber
      self.classroomId = classroomId
      self.classroomName = classroomName
      self.teacherId = teacherId
      self.teacherName = teacherName
      self.departmentName = departmentName
    }

    enum CodingKeys: String, CodingKey {
      case employeeNumber = "employee_number"
      case classroomId = "classroom_id"
      case classroomName = "classroom_name"
      case teacherId = "teacher_id"
      case teacherName = "teacher_name"
      case departmentName = "department_name"
    }
  }

  public struct MFAStatus: Codable, Sendable, Hashable {
    public let required: Bool
    public let verified: Bool

    public init(required: Bool, verified: Bool) {
      self.required = required
      self.verified = verified
    }
  }

  public let id: String
  public let displayName: String
  public let email: String
  public let role: Role
  public let active: Bool
  public let organization: Organization
  public var preferences: Preferences
  public let student: StudentAffiliation?
  public let mfa: MFAStatus

  public init(
    id: String, displayName: String, email: String, role: Role, active: Bool, organization: Organization,
    preferences: Preferences, student: StudentAffiliation?, mfa: MFAStatus
  ) {
    self.id = id
    self.displayName = displayName
    self.email = email
    self.role = role
    self.active = active
    self.organization = organization
    self.preferences = preferences
    self.student = student
    self.mfa = mfa
  }

  enum CodingKeys: String, CodingKey {
    case id
    case displayName = "display_name"
    case email
    case role
    case active
    case organization
    case preferences
    case student
    case mfa
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    displayName = try c.decode(String.self, forKey: .displayName)
    email = try c.decode(String.self, forKey: .email)
    role = try c.decode(Role.self, forKey: .role)
    active = try c.decode(Bool.self, forKey: .active)
    organization = try c.decode(Organization.self, forKey: .organization)
    preferences = try c.decode(Preferences.self, forKey: .preferences)
    student = try c.decodeIfPresent(StudentAffiliation.self, forKey: .student)
    mfa = try c.decode(MFAStatus.self, forKey: .mfa)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(displayName, forKey: .displayName)
    try c.encode(email, forKey: .email)
    try c.encode(role, forKey: .role)
    try c.encode(active, forKey: .active)
    try c.encode(organization, forKey: .organization)
    try c.encode(preferences, forKey: .preferences)
    try c.encode(student, forKey: .student)
    try c.encode(mfa, forKey: .mfa)
  }

  /// Organisation calendar (timezone from the server; default Asia/Tokyo).
  public var calendar: OrgCalendar { OrgCalendar(timeZoneIdentifier: organization.timezone) }
}

/// One organisation offered when `GET /me` answers `409 ORG_SELECTION_REQUIRED`.
public struct OrganizationChoice: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}
