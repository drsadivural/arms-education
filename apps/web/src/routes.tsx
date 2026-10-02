import { Navigate, createBrowserRouter, type RouteObject } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { RequireAuth } from "./components/RequireAuth";
import { ThemeSync } from "./lib/preferences";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoadingRows } from "./components/ui/Feedback";

function RouteFallback() {
  return (
    <div className="p-8">
      <LoadingRows rows={6} label="画面を読み込み中です" />
    </div>
  );
}

/** Page modules are code-split per route. */
const page = (load: () => Promise<{ Component: React.ComponentType }>): Pick<RouteObject, "lazy"> => ({ lazy: load });

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    hydrateFallbackElement: <RouteFallback />,
    element: (
      <RequireAuth>
        <ThemeSync />
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", ...page(async () => ({ Component: (await import("./pages/dashboard/DashboardPage")).DashboardPage })) },
      { path: "teachers", ...page(async () => ({ Component: (await import("./pages/teachers/TeachersPage")).TeachersPage })) },
      { path: "teachers/new", ...page(async () => ({ Component: (await import("./pages/teachers/TeacherFormPage")).TeacherFormPage })) },
      { path: "teachers/:id", ...page(async () => ({ Component: (await import("./pages/teachers/TeacherFormPage")).TeacherFormPage })) },
      { path: "students", ...page(async () => ({ Component: (await import("./pages/students/StudentsPage")).StudentsPage })) },
      { path: "students/new", ...page(async () => ({ Component: (await import("./pages/students/StudentFormPage")).StudentFormPage })) },
      { path: "students/:id", ...page(async () => ({ Component: (await import("./pages/students/StudentFormPage")).StudentFormPage })) },
      { path: "classrooms", ...page(async () => ({ Component: (await import("./pages/classrooms/ClassroomsPage")).ClassroomsPage })) },
      { path: "classrooms/new", ...page(async () => ({ Component: (await import("./pages/classrooms/ClassroomDetailPage")).ClassroomDetailPage })) },
      { path: "classrooms/:id", ...page(async () => ({ Component: (await import("./pages/classrooms/ClassroomDetailPage")).ClassroomDetailPage })) },
      { path: "programs", ...page(async () => ({ Component: (await import("./pages/programs/ProgramsPage")).ProgramsPage })) },
      { path: "programs/new", ...page(async () => ({ Component: (await import("./pages/programs/ProgramEditPage")).ProgramEditPage })) },
      { path: "programs/:id", ...page(async () => ({ Component: (await import("./pages/programs/ProgramEditPage")).ProgramEditPage })) },
      { path: "progress", ...page(async () => ({ Component: (await import("./pages/progress/ProgressPage")).ProgressPage })) },
      { path: "progress/records/:id", ...page(async () => ({ Component: (await import("./pages/progress/ProgressRecordPage")).ProgressRecordPage })) },
      { path: "bookings", ...page(async () => ({ Component: (await import("./pages/bookings/BookingsPage")).BookingsPage })) },
      { path: "bookings/reservations/:id", ...page(async () => ({ Component: (await import("./pages/bookings/ReservationDetailPage")).ReservationDetailPage })) },
      { path: "bookings/slots/new", ...page(async () => ({ Component: (await import("./pages/bookings/SlotFormPage")).SlotFormPage })) },
      { path: "bookings/slots/:id", ...page(async () => ({ Component: (await import("./pages/bookings/SlotFormPage")).SlotFormPage })) },
      { path: "settings", ...page(async () => ({ Component: (await import("./pages/settings/SettingsPage")).SettingsPage })) },
      { path: "settings/:tab", ...page(async () => ({ Component: (await import("./pages/settings/SettingsPage")).SettingsPage })) },
      { path: "voice", ...page(async () => ({ Component: (await import("./pages/voice/VoicePage")).VoicePage })) },
      { path: "notifications", ...page(async () => ({ Component: (await import("./pages/notifications/NotificationsPage")).NotificationsPage })) },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
