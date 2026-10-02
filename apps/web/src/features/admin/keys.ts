/** TanStack Query keys of the admin screens (invalidate by prefix after mutations). */
type Filters = Record<string, string | undefined>;

export const adminKeys = {
  all: ["admin"] as const,
  dashboard: (filters: Filters) => ["admin", "dashboard", filters] as const,
  dashboardAll: ["admin", "dashboard"] as const,

  teachers: ["admin", "teachers"] as const,
  teacherList: (filters: Filters) => ["admin", "teachers", "list", filters] as const,
  teacherOptions: (filters: Filters) => ["admin", "teachers", "options", filters] as const,
  teacher: (id: string) => ["admin", "teachers", "detail", id] as const,

  students: ["admin", "students"] as const,
  studentList: (filters: Filters) => ["admin", "students", "list", filters] as const,
  student: (id: string) => ["admin", "students", "detail", id] as const,

  classrooms: ["admin", "classrooms"] as const,
  classroomList: (filters: Filters) => ["admin", "classrooms", "list", filters] as const,
  classroomOptions: (filters: Filters) => ["admin", "classrooms", "options", filters] as const,
  classroom: (id: string) => ["admin", "classrooms", "detail", id] as const,
  classroomStudents: (id: string) => ["admin", "classrooms", "students", id] as const,
  classroomTeachers: (id: string) => ["admin", "classrooms", "teachers", id] as const,

  programs: ["admin", "programs"] as const,
  programVersion: (id: string) => ["admin", "programs", "version", id] as const,

  settings: ["admin", "settings"] as const,
  users: ["admin", "users"] as const,
  userList: (filters: Filters) => ["admin", "users", "list", filters] as const,
  deletionRequests: ["admin", "users", "deletion-requests"] as const,
  events: (filters: Filters) => ["admin", "events", filters] as const,
  eventsAll: ["admin", "events"] as const,
  deliveries: (filters: Filters) => ["admin", "deliveries", filters] as const,
  deliveriesAll: ["admin", "deliveries"] as const,
};
