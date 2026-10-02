import pg from "pg";
import { compile, type SqlFragment } from "./sql";
import { ApiError, mapDbError } from "../http/errors";

/** A connection that can run queries (pg.Client or pg.PoolClient). */
export interface RawConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface ConnectionLease {
  conn: RawConnection;
  release(destroy?: boolean): Promise<void>;
}

/** Source of database connections: per-request pg.Client over Hyperdrive in Workers, a pg.Pool in tests. */
export interface ConnectionSource {
  acquire(): Promise<ConnectionLease>;
}

/** Workers: Hyperdrive maintains the pool, so a fresh client per request is the recommended pattern. */
export function hyperdriveSource(connectionString: string): ConnectionSource {
  return {
    async acquire() {
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
      } catch (e) {
        throw new ApiError("DB_UNAVAILABLE", { cause: e });
      }
      return {
        conn: client,
        release: async () => {
          await client.end().catch(() => undefined);
        },
      };
    },
  };
}

export function poolSource(pool: pg.Pool): ConnectionSource {
  return {
    async acquire() {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (e) {
        throw new ApiError("DB_UNAVAILABLE", { cause: e });
      }
      return {
        conn: client,
        release: async (destroy) => client.release(destroy ? true : undefined),
      };
    },
  };
}

/** Query helpers bound to one connection inside one transaction. */
export class Tx {
  constructor(readonly conn: RawConnection) {}

  async query<T = Record<string, unknown>>(q: SqlFragment): Promise<T[]> {
    const { text, values } = compile(q);
    const res = await this.conn.query(text, values);
    return res.rows as T[];
  }

  async one<T = Record<string, unknown>>(q: SqlFragment): Promise<T> {
    const rows = await this.query<T>(q);
    if (rows.length !== 1) throw new ApiError("NOT_FOUND");
    return rows[0] as T;
  }

  async maybeOne<T = Record<string, unknown>>(q: SqlFragment): Promise<T | null> {
    const rows = await this.query<T>(q);
    return (rows[0] as T | undefined) ?? null;
  }

  async exec(q: SqlFragment): Promise<number> {
    const { text, values } = compile(q);
    const res = await this.conn.query(text, values);
    return res.rowCount ?? 0;
  }
}

export interface TxContext {
  /** Tenant for RLS (app.org_id). */
  orgId?: string;
  /** Acting user (app.user_id) used by SQL functions for authorisation and audit. */
  userId?: string;
  /** Verified JWT subject, set only during authentication bootstrap (app.auth_user_id). */
  authUserId?: string;
}

const RETRYABLE = new Set(["40001", "40P01"]);

/**
 * Per-request database handle. All work runs as BEGIN → set_config(..., true) → work → COMMIT on one
 * connection, so the tenant context is transaction-local and cannot leak through pooled connections.
 */
export class RequestDb {
  private lease: ConnectionLease | null = null;
  private broken = false;

  constructor(private readonly source: ConnectionSource) {}

  private async connection(): Promise<RawConnection> {
    if (!this.lease) this.lease = await this.source.acquire();
    return this.lease.conn;
  }

  async tx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connection();
      try {
        await conn.query("BEGIN");
        await conn.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.auth_user_id', $3, true)",
          [ctx.orgId ?? "", ctx.userId ?? "", ctx.authUserId ?? ""],
        );
        const result = await fn(new Tx(conn));
        await conn.query("COMMIT");
        return result;
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => {
          this.broken = true;
        });
        const code = (e as { code?: string }).code;
        if (code && RETRYABLE.has(code) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 30));
          continue;
        }
        if (e instanceof ApiError) throw e;
        const mapped = mapDbError(e);
        if (mapped) {
          if (mapped.code === "DB_UNAVAILABLE") this.broken = true;
          throw mapped;
        }
        throw e;
      }
    }
  }

  async close(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (lease) await lease.release(this.broken);
  }
}

export const json = (value: unknown): string => JSON.stringify(value);
