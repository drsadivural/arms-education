import { Hono } from "hono";
import type { AppEnv } from "../context";
import { teacherRoutes } from "./admin/teachers";
import { studentRoutes } from "./admin/students";
import { classroomRoutes } from "./admin/classrooms";
import { dashboardRoutes } from "./admin/dashboard";
import { settingsRoutes } from "./admin/settings";
import { userRoutes } from "./admin/users";
import { eventRoutes } from "./admin/events";

/** Teachers, students, classrooms, dashboard, settings, user management and audit events (WEB-02〜08, WEB-16, WEB-18, WEB-19). */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.route("/", dashboardRoutes);
adminRoutes.route("/", teacherRoutes);
adminRoutes.route("/", studentRoutes);
adminRoutes.route("/", classroomRoutes);
adminRoutes.route("/", settingsRoutes);
adminRoutes.route("/", userRoutes);
adminRoutes.route("/", eventRoutes);
