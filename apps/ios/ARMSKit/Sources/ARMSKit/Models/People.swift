import Foundation

/// Contract `Student` (teacher-scoped list/detail).
public struct Student: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let employeeNumber: String
  public let displayName: String
  public let kana: String
  public let email: String
  public let companyName: String
  public let departmentName: String
  public let joinedOn: LocalDate
  public let classroomId: String
  public let teacherId: String
  public let trainingStartsOn: LocalDate
  public let trainingDueOn: LocalDate
  public let active: Bool
  public let rowVersion: Int
  public let progressPercent: Int?
  /// Display names resolved by the server (contract `Student.classroom_name` / `teacher_name`).
  public let classroomName: String?
  public let teacherName: String?

  public init(
    id: String, employeeNumber: String, displayName: String, kana: String, email: String, companyName: String,
    departmentName: String, joinedOn: LocalDate, classroomId: String, teacherId: String, trainingStartsOn: LocalDate,
    trainingDueOn: LocalDate, active: Bool, rowVersion: Int, progressPercent: Int?, classroomName: String? = nil,
    teacherName: String? = nil
  ) {
    self.id = id
    self.employeeNumber = employeeNumber
    self.displayName = displayName
    self.kana = kana
    self.email = email
    self.companyName = companyName
    self.departmentName = departmentName
    self.joinedOn = joinedOn
    self.classroomId = classroomId
    self.teacherId = teacherId
    self.trainingStartsOn = trainingStartsOn
    self.trainingDueOn = trainingDueOn
    self.active = active
    self.rowVersion = rowVersion
    self.progressPercent = progressPercent
    self.classroomName = classroomName
    self.teacherName = teacherName
  }

  enum CodingKeys: String, CodingKey {
    case id
    case employeeNumber = "employee_number"
    case displayName = "display_name"
    case kana
    case email
    case companyName = "company_name"
    case departmentName = "department_name"
    case joinedOn = "joined_on"
    case classroomId = "classroom_id"
    case teacherId = "teacher_id"
    case trainingStartsOn = "training_starts_on"
    case trainingDueOn = "training_due_on"
    case active
    case rowVersion = "row_version"
    case progressPercent = "progress_percent"
    case classroomName = "classroom_name"
    case teacherName = "teacher_name"
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    employeeNumber = try c.decode(String.self, forKey: .employeeNumber)
    displayName = try c.decode(String.self, forKey: .displayName)
    kana = try c.decode(String.self, forKey: .kana)
    email = try c.decode(String.self, forKey: .email)
    companyName = try c.decode(String.self, forKey: .companyName)
    departmentName = try c.decode(String.self, forKey: .departmentName)
    joinedOn = try c.decode(LocalDate.self, forKey: .joinedOn)
    classroomId = try c.decode(String.self, forKey: .classroomId)
    teacherId = try c.decode(String.self, forKey: .teacherId)
    trainingStartsOn = try c.decode(LocalDate.self, forKey: .trainingStartsOn)
    trainingDueOn = try c.decode(LocalDate.self, forKey: .trainingDueOn)
    active = try c.decode(Bool.self, forKey: .active)
    rowVersion = try c.decode(Int.self, forKey: .rowVersion)
    progressPercent = try c.decodeIfPresent(Int.self, forKey: .progressPercent)
    classroomName = try c.decodeIfPresent(String.self, forKey: .classroomName)
    teacherName = try c.decodeIfPresent(String.self, forKey: .teacherName)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(employeeNumber, forKey: .employeeNumber)
    try c.encode(displayName, forKey: .displayName)
    try c.encode(kana, forKey: .kana)
    try c.encode(email, forKey: .email)
    try c.encode(companyName, forKey: .companyName)
    try c.encode(departmentName, forKey: .departmentName)
    try c.encode(joinedOn, forKey: .joinedOn)
    try c.encode(classroomId, forKey: .classroomId)
    try c.encode(teacherId, forKey: .teacherId)
    try c.encode(trainingStartsOn, forKey: .trainingStartsOn)
    try c.encode(trainingDueOn, forKey: .trainingDueOn)
    try c.encode(active, forKey: .active)
    try c.encode(rowVersion, forKey: .rowVersion)
    try c.encode(progressPercent, forKey: .progressPercent)
    try c.encodeIfPresent(classroomName, forKey: .classroomName)
    try c.encodeIfPresent(teacherName, forKey: .teacherName)
  }
}

/// Contract `Classroom` (teacher-scoped list, used for the class filter and names).
public struct Classroom: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let name: String
  public let capacity: Int
  public let startsOn: LocalDate
  public let endsOn: LocalDate
  public let primaryTeacherId: String
  public let assistantTeacherIds: [String]
  public let programVersionIds: [String]
  public let studentCount: Int
  public let archived: Bool
  public let rowVersion: Int

  public init(
    id: String, name: String, capacity: Int, startsOn: LocalDate, endsOn: LocalDate, primaryTeacherId: String,
    assistantTeacherIds: [String], programVersionIds: [String], studentCount: Int, archived: Bool, rowVersion: Int
  ) {
    self.id = id
    self.name = name
    self.capacity = capacity
    self.startsOn = startsOn
    self.endsOn = endsOn
    self.primaryTeacherId = primaryTeacherId
    self.assistantTeacherIds = assistantTeacherIds
    self.programVersionIds = programVersionIds
    self.studentCount = studentCount
    self.archived = archived
    self.rowVersion = rowVersion
  }

  enum CodingKeys: String, CodingKey {
    case id
    case name
    case capacity
    case startsOn = "starts_on"
    case endsOn = "ends_on"
    case primaryTeacherId = "primary_teacher_id"
    case assistantTeacherIds = "assistant_teacher_ids"
    case programVersionIds = "program_version_ids"
    case studentCount = "student_count"
    case archived
    case rowVersion = "row_version"
  }
}

/// Contract `Teacher` (used to resolve teacher names in teacher-scoped lists).
public struct Teacher: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let displayName: String
  public let email: String
  public let teacherNumber: String
  public let departmentName: String
  public let specialties: [String]
  public let classroomIds: [String]
  public let studentCount: Int
  public let active: Bool
  public let rowVersion: Int

  enum CodingKeys: String, CodingKey {
    case id
    case displayName = "display_name"
    case email
    case teacherNumber = "teacher_number"
    case departmentName = "department_name"
    case specialties
    case classroomIds = "classroom_ids"
    case studentCount = "student_count"
    case active
    case rowVersion = "row_version"
  }
}
