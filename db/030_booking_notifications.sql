-- 030: booking & notification runtime support (docs/04 予約, docs/02 予約・同期/外部障害, db/RUNTIME_ROLE_JA.md).
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Outbox delivery bookkeeping. last_error holds an error CODE only (never provider text or PII).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.outbox
  ADD COLUMN last_error text CHECK (last_error IS NULL OR last_error ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  ADD COLUMN delivered_at timestamptz;
CREATE INDEX outbox_org_due ON app.outbox (org_id, next_attempt_at) WHERE state IN ('pending', 'processing');

-- One row per external delivery attempt target: (notification, channel, target) where target is 'email'
-- for e-mail and the device token hash for APNs. A 'sent' row is never sent again, so outbox retries
-- cannot double-send; providers additionally receive a stable idempotency key / collapse id.
CREATE TABLE app.notification_deliveries (
  org_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'push')),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'skipped', 'invalid_token')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (org_id, notification_id, channel, target),
  FOREIGN KEY (org_id, notification_id) REFERENCES app.notifications (org_id, id) ON DELETE CASCADE,
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
);
ALTER TABLE app.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.notification_deliveries USING (org_id = app.org_id()) WITH CHECK (org_id = app.org_id());
CREATE INDEX notification_deliveries_state ON app.notification_deliveries (org_id, state, updated_at DESC);

-- Device registrations: bookkeeping columns and lookup by hash (a token belongs to the latest user).
ALTER TABLE app.device_tokens
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT device_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX device_tokens_hash ON app.device_tokens (org_id, token_hash);

-- List indexes.
CREATE INDEX notifications_unread ON app.notifications (org_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX reservations_slot_created ON app.reservations (org_id, slot_id, created_at);
CREATE INDEX reservations_created ON app.reservations (org_id, created_at DESC, id);
CREATE INDEX lesson_slots_teacher_time ON app.lesson_slots (org_id, teacher_id, starts_at);
CREATE INDEX lesson_slots_classroom_time ON app.lesson_slots (org_id, classroom_id, starts_at);

-- ---------------------------------------------------------------------------------------------
-- Lazy expiry helpers (RUNTIME_ROLE_JA.md): expiries are committed in their own transaction before the
-- business call, locking slots in slot-id order so the student time-overlap exclusion constraint is not
-- blocked by stale pending rows and so a failed decision cannot roll the expiry back.
-- ---------------------------------------------------------------------------------------------

-- Expires the calling student's due pending reservations (all slots, slot-id order). Returns the slot count.
CREATE FUNCTION app.expire_actor_pendings() RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_slot uuid; n int := 0;
BEGIN
  FOR v_slot IN
    SELECT DISTINCT slot_id FROM app.reservations
    WHERE org_id = app.org_id() AND student_id = app.actor_id() AND status = 'pending' AND expires_at <= now()
    ORDER BY slot_id
  LOOP
    PERFORM 1 FROM app.lesson_slots WHERE org_id = app.org_id() AND id = v_slot FOR UPDATE;
    PERFORM app.expire_slot(v_slot);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Expires the reservation's slot when this reservation's pending hold is due. Returns true when it did.
CREATE FUNCTION app.expire_reservation_if_due(p_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_slot uuid;
BEGIN
  SELECT slot_id INTO v_slot FROM app.reservations
  WHERE org_id = app.org_id() AND id = p_id AND status = 'pending' AND expires_at <= now();
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM app.lesson_slots WHERE org_id = app.org_id() AND id = v_slot FOR UPDATE;
  PERFORM app.expire_slot(v_slot);
  RETURN EXISTS (SELECT 1 FROM app.reservations WHERE org_id = app.org_id() AND id = p_id AND status = 'expired');
END $$;

-- ---------------------------------------------------------------------------------------------
-- Student booking entry point. Same advisory lock as app.create_reservation (re-entrant within the
-- transaction), then the slot row lock, so a second active request for the same slot by the same student
-- is reported as ALREADY_RESERVED instead of the generic exclusion/unique violation. Idempotent replays
-- (same key) go straight to app.create_reservation, which returns the stored row or IDEMPOTENCY_CONFLICT.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.reserve_slot(p_slot uuid, p_key uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(app.org_id()::text || app.actor_id()::text || p_key::text, 0));
  IF NOT EXISTS (SELECT 1 FROM app.reservations WHERE org_id = app.org_id() AND student_id = app.actor_id() AND idempotency_key = p_key) THEN
    PERFORM 1 FROM app.lesson_slots WHERE org_id = app.org_id() AND id = p_slot FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM app.reservations
      WHERE org_id = app.org_id() AND slot_id = p_slot AND student_id = app.actor_id()
        AND (status = 'approved' OR (status = 'pending' AND expires_at > now()))
    ) THEN
      RAISE EXCEPTION 'ALREADY_RESERVED';
    END IF;
  END IF;
  RETURN app.create_reservation(p_slot, p_key);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Slot cancellation (「管理者が取消通知を実行してから新枠を作る」): admin or the slot's teacher, reason
-- 1〜1000 characters, optimistic version. All pending/approved reservations become 'cancelled' with the
-- reason in the same transaction; every transition is audited and queued for notification.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.cancel_slot(p_slot uuid, p_reason text, p_expected_version int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s app.lesson_slots; role_name text; r record; n int := 0;
BEGIN
  SELECT role INTO role_name FROM app.memberships WHERE org_id = app.org_id() AND id = app.actor_id() AND active;
  IF role_name IS NULL OR role_name NOT IN ('admin', 'teacher') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT * INTO s FROM app.lesson_slots WHERE org_id = app.org_id() AND id = p_slot FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF role_name = 'teacher' AND s.teacher_id <> app.actor_id() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_expected_version IS NULL OR s.row_version <> p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF s.state = 'cancelled' THEN RAISE EXCEPTION 'INVALID_STATE'; END IF;
  PERFORM app.expire_slot(p_slot);
  FOR r IN
    UPDATE app.reservations SET status = 'cancelled', reason = trim(p_reason), row_version = row_version + 1, updated_at = now()
    WHERE org_id = app.org_id() AND slot_id = p_slot AND status IN ('pending', 'approved')
    RETURNING id, student_id
  LOOP
    PERFORM app.emit_booking(app.org_id(), r.id, 'reservation.cancelled',
      jsonb_build_object('status', 'cancelled', 'reason', trim(p_reason), 'student_id', r.student_id, 'slot_id', p_slot, 'source', 'slot_cancel'));
    n := n + 1;
  END LOOP;
  UPDATE app.lesson_slots SET state = 'cancelled', row_version = row_version + 1
  WHERE org_id = app.org_id() AND id = p_slot RETURNING * INTO s;
  PERFORM app.emit_booking(app.org_id(), p_slot, 'lesson_slot.cancelled',
    jsonb_build_object('reason', trim(p_reason), 'cancelled_reservations', n, 'teacher_id', s.teacher_id, 'state', 'cancelled'));
  RETURN jsonb_build_object('id', s.id, 'state', s.state, 'row_version', s.row_version, 'cancelled_reservations', n);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
