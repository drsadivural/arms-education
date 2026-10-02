import { Hono } from "hono";
import type { AppEnv } from "../context";
import { programRoutes } from "./learning/programs";
import { materialRoutes } from "./learning/materials";
import { submissionRoutes } from "./learning/submissions";
import { uploadRoutes } from "./learning/uploads";
import { enrollmentRoutes } from "./learning/enrollments";
import { progressRoutes } from "./learning/progress";
import { exportRoutes } from "./learning/exports";

/** Programs, versions, units, materials, uploads, quizzes, submissions, enrollments, progress and exports (WEB-09〜12, IOS-04〜06, IOS-12). */
export const learningRoutes = new Hono<AppEnv>();
learningRoutes.route("/", programRoutes);
learningRoutes.route("/", materialRoutes);
learningRoutes.route("/", submissionRoutes);
learningRoutes.route("/", uploadRoutes);
learningRoutes.route("/", enrollmentRoutes);
learningRoutes.route("/", progressRoutes);
learningRoutes.route("/", exportRoutes);
