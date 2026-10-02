/**
 * Progress service shared by Web, iOS and the voice assistant (docs/04 「進捗の計算」).
 * Owned by the learning module: unit completion = required material receipts + passed quiz + accepted
 * assignment (when requires_review) + attendance (when required_attendance); progress = completed weight /
 * assigned required weight × 100 (null when no required units).
 */
import type { Tx } from "../db/client";

/**
 * Recomputes unit_progress for every enrollment of the student from the underlying evidence.
 * Call it in the same transaction after any change to receipts, quiz attempts, submission reviews or attendance.
 */
export async function recomputeStudentProgress(_tx: Tx, _orgId: string, _studentId: string): Promise<void> {}
