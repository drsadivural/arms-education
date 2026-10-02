/**
 * Scheduled work (Cron Trigger every minute) and Queue consumption. Each job iterates organisations and runs
 * with that organisation's tenant context; failures in one organisation do not stop the others.
 */
import type { Deps } from "../context";
import { runBookingJobs } from "./booking";
import { runLearningJobs } from "./learning";
import { runVoiceJobs } from "./voice";
import { runAdminJobs } from "./admin";

export async function runScheduled(deps: Deps): Promise<void> {
  const results = await Promise.allSettled([runBookingJobs(deps), runLearningJobs(deps), runVoiceJobs(deps), runAdminJobs(deps)]);
  for (const r of results) {
    if (r.status === "rejected") {
      const e = r.reason as { name?: string; code?: string; message?: string };
      deps.log({ level: "error", msg: "scheduled_job_failed", error_name: e?.name, error_code: e?.code, error_message: e?.message?.slice(0, 300) });
    }
  }
}
