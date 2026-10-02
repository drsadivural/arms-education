# ARMS implementation conventions

Developer-facing rules for the monorepo. Product requirements live in `docs/01〜10_*_JA.md` (Japanese);
when this file and those docs disagree, the docs win — record the difference in `contracts/CHANGELOG_JA.md`
or the relevant doc.

## Repository layout

| Path | Contents |
|---|---|
| `packages/contracts` | Effective OpenAPI (`openapi.json`, generated), TS types (`src/openapi.d.ts`, generated), Zod request schemas (`src/schemas.ts`), error catalogue with Japanese messages (`src/errors.ts`), labels (`src/labels.ts`), org-timezone date helpers (`src/time.ts`). Shared by API and Web. |
| `contracts/openapi.json` | Handoff contract — **never edit**. |
| `contracts/extensions/NN-area.json` | Our additions/corrections. Same path+method or schema name **replaces** the base one. Run `pnpm gen:contracts` after editing. Document each change in `contracts/CHANGELOG_JA.md`. |
| `db/NNN_name.sql` | Forward-only migrations (each wrapped in `BEGIN/COMMIT`). Never edit an applied migration. `db/grants.sql` re-grants the runtime role after migrations. |
| `services/api` | Cloudflare Worker (Hono). `src/routes/<area>.ts`, `src/domain/`, `src/repositories/`, `src/integrations/`, `src/jobs/`. |
| `apps/web` | React + Vite + Tailwind admin/teacher Web app (served as Worker static assets). |
| `apps/ios` | SwiftUI app (XcodeGen project) + `ARMSKit` Swift package (Linux-testable core). |
| `infra/local` | Docker compose: PostgreSQL 17, Supabase Auth (GoTrue, ES256), MinIO, Mailpit. |

Migration number ranges (to avoid collisions between parallel work): `004` core, `010–019` admin,
`020–029` learning, `030–039` booking/notifications, `040–049` voice, `050–059` imports/exports.

## API rules (services/api)

**Authentication is default-deny.** `routes/index.ts` authenticates every request except
`GET /health`, `POST /auth/login`, `POST /auth/password-reset`. Never call `app.use("*", …)` inside a route
module (Hono applies it to every route of the parent app). Per-route guards:

```ts
adminRoutes.get("/teachers", requireRole("admin", "teacher"), async (c) => { … });
```

**Actor.** `c.get("actor")` gives `{ userId, orgId, role, orgName, timezone, displayName, method }`, derived from
the verified JWT/session + DB membership. Never read org/user/role from the request.

**Database.** Use `actorTx(c, async (tx) => …)` — it opens one transaction, sets `app.org_id` / `app.user_id`
(RLS + SQL-function authorisation) and commits. Build queries only with the `sql` tagged template
(`src/db/sql.ts`); values become bind parameters. Use `ident()` for allowlisted column names in ORDER BY.
JSONB parameters: `${json(obj)}::jsonb`. Do not run two `tx` calls concurrently on the same request.
RLS isolates organisations only; **teacher/student scoping must be enforced in the query** (e.g. a teacher may
read only students where `teacher_id = actor.userId` or in classrooms they teach — return 404 for out-of-scope
single resources and filter lists). Write the scope rule in a small repository function and test it.

**Errors.** Throw `fail("CODE")` / `new ApiError("CODE", { field_errors })` with codes from
`packages/contracts/src/errors.ts` (add new codes there with a Japanese message). SQL functions `RAISE`
these codes; `mapDbError` converts SQLSTATEs (unique → `*_TAKEN`/`DUPLICATE`, exclusion → `TIME_CONFLICT`,
RLS → `FORBIDDEN`). Never return SQL/provider messages to clients.

**Validation.** `readBody(c, Schema)` with schemas from `@arms/contracts` (extend there if the contract
changes); `readQuery(c, z.object(…))`; `pathId(c)` (malformed UUID → 404).

**Responses.** Follow the contract exactly:
`ok(c, data, { version })` → `{ data, checked_at }` (+ `ETag`); `page(c, items, nextCursor)` →
`{ items, next_cursor, checked_at }`; `action(c, data?)` → `{ success, checked_at, data? }`. Every endpoint test
calls `expectContract(res, method, pathTemplate)` (Ajv against `packages/contracts/openapi.json`).
Lists: keyset pagination (`paginate`, `encodeCursor`, `decodeCursor`), default limit 30, max 100.

**Writes.**
- `POST`/`PUT` with an `Idempotency-Key` parameter in the contract: wrap the work in
  `idempotent(c, tx, input, async () => ({ status, body }))` inside the same `actorTx`.
- `PATCH`/`DELETE`: `requireIfMatch(c)` → compare with `row_version` in the `UPDATE … WHERE row_version = $v`;
  0 rows → `VERSION_CONFLICT`. Increment `row_version` on every update.
- Every business mutation inserts an `app.audit_events` row (actor, event_type `entity.verb`, entity_id,
  payload with before/after where relevant — never secrets, tokens, full voice transcripts or file contents)
  and, when someone must be notified, an `app.outbox` row **in the same transaction**.
- Deleting business records is a soft operation (archive/disable/`removed`) unless the docs say otherwise.

**Time.** Store `timestamptz`/`date`. Compute "today", month filters and overdue in the organisation timezone
(`actor.timezone`) with `@arms/contracts` helpers (`zonedDateString`, `zonedDayRange`, `zonedMonthRange`).
Never truncate UTC timestamps to get a local date.

**External services** live behind interfaces in `src/integrations/*`. When a service is not configured the slot
is `null`; the feature must respond `NOT_CONFIGURED` (or keep content unpublished), never fake success.

**Logging.** `deps.log({...})` structured JSON. Never log tokens, passwords, cookies, e-mail bodies, voice audio
or transcripts, or file contents.

## Tests

`pnpm --filter @arms/api test` creates a fresh database on the local PostgreSQL (`infra/local/compose.yaml`,
port 55433; override with `TEST_DATABASE_ADMIN_URL`), applies all migrations and runs the API as the
NOSUPERUSER/NOBYPASSRLS runtime role. Helpers in `services/api/test/helpers`:
`createTestContext()` (in-process app + pools; `ctx.admin` is the owner pool for fixtures/assertions),
`seedOrg()` and other fixture builders, `bearerCaller()` (iOS teacher/student), `cookieCaller()` (Web; admin
sessions are MFA-complete), `call(ctx, caller, method, path, { body, ifMatch, idempotencyKey })`,
`expectContract()`. Test-only fakes for external services implement the same integration interfaces.

Every endpoint needs: success + contract check, 401 (no auth), 403 (wrong role), out-of-scope access
(other teacher's student / other student / other organisation), validation 422 with Japanese field errors,
and the business conflicts it can raise (409s). Concurrency rules (capacity, idempotency) need parallel tests.

## Web (apps/web)

React 19 + TypeScript + Vite + Tailwind v4 + Radix primitives + TanStack Query/Table, all UI text Japanese,
dates via `@arms/contracts` time helpers (Asia/Tokyo). The API client sends the CSRF token and an
`Idempotency-Key` per user action (reused on retry of the same action). Every list/screen implements
loading (skeleton), empty (next action), error (+ retry, request id) and offline states, shows
`最終取得` (checked_at), keeps filters in the URL, and supports light/dark/system themes, keyboard use and
390 px width. Forms: shared add/edit component, required markers, field errors from the API, saving state,
duplicate-submit prevention, dirty-leave confirmation, success toast.

## iOS (apps/ios)

SwiftUI, iOS 17+, NavigationStack/TabView (ホーム/進捗/予約/AI音声), MVVM with `@Observable` view models on the
MainActor, `ARMSKit` package for DTOs/API client/auth token storage/business formatting (compiles and tests on
Linux with `swift test`; UI target is built in macOS CI). Bearer tokens from Supabase Auth stored in Keychain.
