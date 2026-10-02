/**
 * Worker bindings and validated configuration. Required production values are checked at startup
 * (fail-fast); secrets are never logged or echoed in errors.
 */
export interface Bindings {
  APP_ENV?: string;
  APP_ORIGIN?: string;
  DEFAULT_TIMEZONE?: string;

  HYPERDRIVE?: Hyperdrive;
  /** Local development / tests only: direct runtime-role connection string when no Hyperdrive binding exists. */
  DATABASE_URL?: string;

  /** AES-256-GCM key (32 bytes, base64): web-session CSRF tokens and administrator TOTP secrets at rest. */
  WEB_SESSION_ENCRYPTION_KEY?: string;

  OPENAI_API_KEY?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_REALTIME_VOICE?: string;

  R2_MATERIALS?: R2Bucket;
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  NOTIFICATION_QUEUE?: Queue;

  MAIL_PROVIDER_API_KEY?: string;
  MAIL_PROVIDER_URL?: string;
  MAIL_FROM?: string;

  MALWARE_SCAN_URL?: string;
  MALWARE_SCAN_API_KEY?: string;

  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_HOST?: string;
  IOS_BUNDLE_ID?: string;

  DEVICE_TOKEN_ENCRYPTION_KEY?: string;

  VOICE_MAX_SESSION_SECONDS?: string;
  VOICE_DAILY_QUOTA_SECONDS?: string;
  BOOKING_PENDING_TTL_SECONDS?: string;
  BOOKING_CANCEL_BEFORE_SECONDS?: string;

  LOGIN_RATE_LIMITER?: RateLimit;
  API_RATE_LIMITER?: RateLimit;
}

export interface Config {
  env: "development" | "test" | "staging" | "production";
  appOrigin: string;
  /** Session cookies carry `Secure` whenever the app origin is HTTPS (always in staging/production). */
  cookieSecure: boolean;
  timezone: string;
  sessionKey: string;
  voice: { model: string; voice: string; maxSessionSeconds: number; dailyQuotaSeconds: number };
  booking: { pendingTtlSeconds: number; cancelBeforeSeconds: number };
}

export class ConfigError extends Error {}

const intOr = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`Invalid integer configuration value`);
  return n;
};

const REQUIRED_IN_DEPLOYED: (keyof Bindings)[] = ["APP_ORIGIN", "WEB_SESSION_ENCRYPTION_KEY", "HYPERDRIVE"];

export function loadConfig(env: Bindings): Config {
  const appEnv = (env.APP_ENV ?? "development") as Config["env"];
  if (!["development", "test", "staging", "production"].includes(appEnv)) throw new ConfigError("APP_ENV is invalid");
  if (appEnv === "staging" || appEnv === "production") {
    const missing = REQUIRED_IN_DEPLOYED.filter((k) => !env[k]);
    if (missing.length) throw new ConfigError(`Missing required configuration: ${missing.join(", ")}`);
  }
  const sessionKey = env.WEB_SESSION_ENCRYPTION_KEY ?? "";
  if (sessionKey && base64Length(sessionKey) !== 32) throw new ConfigError("WEB_SESSION_ENCRYPTION_KEY must be 32 bytes (base64)");
  const appOrigin = (env.APP_ORIGIN ?? "http://localhost:5188").replace(/\/$/, "");
  if ((appEnv === "staging" || appEnv === "production") && !appOrigin.startsWith("https://")) {
    throw new ConfigError("APP_ORIGIN must be an https:// origin in staging/production");
  }
  return {
    env: appEnv,
    appOrigin,
    cookieSecure: appOrigin.startsWith("https://"),
    timezone: env.DEFAULT_TIMEZONE ?? "Asia/Tokyo",
    sessionKey,
    voice: {
      model: env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
      voice: env.OPENAI_REALTIME_VOICE ?? "marin",
      maxSessionSeconds: intOr(env.VOICE_MAX_SESSION_SECONDS, 600),
      dailyQuotaSeconds: intOr(env.VOICE_DAILY_QUOTA_SECONDS, 900),
    },
    booking: {
      pendingTtlSeconds: intOr(env.BOOKING_PENDING_TTL_SECONDS, 86400),
      cancelBeforeSeconds: intOr(env.BOOKING_CANCEL_BEFORE_SECONDS, 86400),
    },
  };
}

function base64Length(b64: string): number {
  try {
    return atob(b64.replace(/-/g, "+").replace(/_/g, "/")).length;
  } catch {
    return -1;
  }
}
