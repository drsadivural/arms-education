import { ERROR_CATALOG, isErrorCode, type ErrorCode } from "@arms/contracts";

export interface ApiErrorOptions {
  message_ja?: string;
  field_errors?: Record<string, string>;
  details?: Record<string, unknown>;
  status?: number;
  cause?: unknown;
}

/** A user-facing error. Rendered as {code, message_ja, request_id, field_errors?, details?}. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message_ja: string;
  readonly field_errors?: Record<string, string>;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, opts: ApiErrorOptions = {}) {
    super(code, opts.cause ? { cause: opts.cause } : undefined);
    this.code = code;
    this.status = opts.status ?? ERROR_CATALOG[code].status;
    this.message_ja = opts.message_ja ?? ERROR_CATALOG[code].message_ja;
    this.field_errors = opts.field_errors;
    this.details = opts.details;
  }
}

export function fail(code: ErrorCode, opts?: ApiErrorOptions): never {
  throw new ApiError(code, opts);
}

export function validationError(field_errors: Record<string, string>, message_ja?: string): ApiError {
  return new ApiError("VALIDATION_FAILED", { field_errors, message_ja });
}

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
  table?: string;
}

const UNIQUE_CONSTRAINT_CODES: [RegExp, ErrorCode][] = [
  [/users_email_unique/, "EMAIL_TAKEN"],
  [/employee_number/, "EMPLOYEE_NUMBER_TAKEN"],
  [/teacher_number/, "TEACHER_NUMBER_TAKEN"],
  [/reservation_one_active/, "DUPLICATE"],
];

function isPgError(e: unknown): e is PgErrorLike {
  return typeof e === "object" && e !== null && typeof (e as PgErrorLike).code === "string";
}

const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "57P01", "57P02", "57P03", "53300"]);

/**
 * Maps PostgreSQL errors to API errors. SQL functions RAISE our error codes (e.g. 'SLOT_FULL');
 * constraint violations are mapped by SQLSTATE. Internal SQL text is never exposed.
 */
export function mapDbError(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  if (!isPgError(e)) {
    const msg = e instanceof Error ? e.message : "";
    if (/Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(msg)) {
      return new ApiError("DB_UNAVAILABLE", { cause: e });
    }
    return null;
  }
  const code = e.code ?? "";
  if (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08")) return new ApiError("DB_UNAVAILABLE", { cause: e });
  if (code === "P0001") {
    const raised = (e.message ?? "").trim();
    if (raised === "IDEMPOTENCY_KEY_REQUIRED") return new ApiError("IDEMPOTENCY_KEY_REQUIRED", { cause: e });
    if (raised === "INVALID_ACTION") return new ApiError("BAD_REQUEST", { cause: e });
    if (isErrorCode(raised)) return new ApiError(raised, { cause: e });
    return new ApiError("INTERNAL", { cause: e });
  }
  switch (code) {
    case "23505": {
      const name = e.constraint ?? "";
      for (const [re, mapped] of UNIQUE_CONSTRAINT_CODES) if (re.test(name)) return new ApiError(mapped, { cause: e });
      return new ApiError("DUPLICATE", { cause: e });
    }
    case "23P01":
      return new ApiError(e.table === "reservations" ? "TIME_CONFLICT" : "SLOT_TIME_CONFLICT", { cause: e });
    case "23503":
      if ((e.constraint ?? "").includes("classroom_id_teacher_id") || e.table === "student_profiles" || e.table === "lesson_slots") {
        return new ApiError("TEACHER_CLASSROOM_MISMATCH", { cause: e });
      }
      return new ApiError("VALIDATION_FAILED", { message_ja: "関連するデータが見つかりません。選択内容を確認してください。", cause: e });
    case "23514":
    case "23502":
    case "22007":
    case "22008":
      return new ApiError("VALIDATION_FAILED", { cause: e });
    case "22P02":
      return new ApiError("NOT_FOUND", { cause: e });
    case "42501":
      return new ApiError("FORBIDDEN", { cause: e });
    case "40001":
    case "40P01":
    case "55P03":
      return new ApiError("SERVICE_UNAVAILABLE", { message_ja: "他の操作と競合しました。もう一度お試しください。", cause: e });
    default:
      return null;
  }
}
