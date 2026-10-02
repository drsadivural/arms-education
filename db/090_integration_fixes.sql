-- 090: fixes found while integrating the admin and booking areas.
BEGIN;

-- transfer_student treated every past approved reservation as active, so a student who had ever attended a lesson
-- could never be transferred. Only future approved lessons and unexpired pending requests block a transfer.
CREATE OR REPLACE FUNCTION app.transfer_student(p_student uuid,p_classroom uuid,p_teacher uuid,p_version int,p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE s app.student_profiles;c uuid;BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE org_id=app.org_id() AND id=app.actor_id() AND active AND role='admin') THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
 SELECT * INTO s FROM app.student_profiles WHERE org_id=app.org_id() AND id=p_student;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 FOR c IN SELECT id FROM app.classrooms WHERE org_id=app.org_id() AND id IN(s.classroom_id,p_classroom) ORDER BY id LOOP PERFORM 1 FROM app.classrooms WHERE org_id=app.org_id() AND id=c FOR UPDATE;END LOOP;
 SELECT * INTO s FROM app.student_profiles WHERE org_id=app.org_id() AND id=p_student FOR UPDATE;
 IF s.row_version<>p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM app.reservations WHERE org_id=app.org_id() AND student_id=p_student AND ((status='approved' AND ends_at>now()) OR (status='pending' AND expires_at>now()))) THEN RAISE EXCEPTION 'ACTIVE_RESERVATIONS';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.classroom_teachers ct JOIN app.memberships m ON m.org_id=ct.org_id AND m.id=ct.teacher_id WHERE ct.org_id=app.org_id() AND ct.classroom_id=p_classroom AND ct.teacher_id=p_teacher AND m.active AND m.role='teacher') THEN RAISE EXCEPTION 'TEACHER_CLASSROOM_MISMATCH';END IF;
 PERFORM set_config('app.allow_transfer','yes',true);
 UPDATE app.student_profiles SET classroom_id=p_classroom,teacher_id=p_teacher,row_version=row_version+1 WHERE org_id=app.org_id() AND id=p_student RETURNING * INTO s;
 PERFORM set_config('app.allow_transfer','no',true);
 INSERT INTO app.audit_events(org_id,actor_id,event_type,entity_id,payload) VALUES(app.org_id(),app.actor_id(),'student.transferred',p_student,jsonb_build_object('classroom_id',p_classroom,'teacher_id',p_teacher,'reason',p_reason));RETURN to_jsonb(s);END $$;

-- Registering into an archived classroom reported CLASSROOM_FULL; report the real reason.
CREATE OR REPLACE FUNCTION app.guard_classroom_capacity() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE cap int;used int; BEGIN
 PERFORM 1 FROM app.classrooms WHERE org_id=NEW.org_id AND id=NEW.classroom_id FOR UPDATE;
 IF TG_OP='UPDATE' AND OLD.classroom_id<>NEW.classroom_id AND current_setting('app.allow_transfer',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'CLASSROOM_TRANSFER_REQUIRES_SERVICE'; END IF;
 IF NEW.active THEN SELECT capacity INTO cap FROM app.classrooms WHERE org_id=NEW.org_id AND id=NEW.classroom_id AND NOT archived;
 SELECT count(*) INTO used FROM app.student_profiles WHERE org_id=NEW.org_id AND classroom_id=NEW.classroom_id AND active AND id<>NEW.id;
 IF cap IS NULL THEN RAISE EXCEPTION 'CLASSROOM_ARCHIVED'; END IF;
 IF used>=cap THEN RAISE EXCEPTION 'CLASSROOM_FULL'; END IF; END IF; RETURN NEW; END $$;

-- reserve_slot: take a share lock on the student's profile so a reservation cannot be created for a student who is
-- being archived/transferred concurrently.
CREATE OR REPLACE FUNCTION app.reserve_slot(p_slot uuid, p_key uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s app.lesson_slots; v_ttl int;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(app.org_id()::text || app.actor_id()::text || p_key::text, 0));
  -- Serialise with a concurrent archive/transfer of the student (UPDATE of the profile waits for this lock).
  PERFORM 1 FROM app.student_profiles WHERE org_id = app.org_id() AND id = app.actor_id() FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM app.reservations WHERE org_id = app.org_id() AND student_id = app.actor_id() AND idempotency_key = p_key) THEN
    SELECT * INTO s FROM app.lesson_slots WHERE org_id = app.org_id() AND id = p_slot FOR UPDATE;
    IF FOUND THEN
      IF EXISTS (
        SELECT 1 FROM app.reservations
        WHERE org_id = app.org_id() AND slot_id = p_slot AND student_id = app.actor_id()
          AND (status = 'approved' OR (status = 'pending' AND expires_at > now()))
      ) THEN
        RAISE EXCEPTION 'ALREADY_RESERVED';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM app.memberships m WHERE m.org_id = s.org_id AND m.id = s.teacher_id AND m.active) THEN
        RAISE EXCEPTION 'BOOKING_CLOSED';
      END IF;
      IF s.unit_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM app.units u
        WHERE u.org_id = s.org_id AND u.id = s.unit_id AND (
          EXISTS (SELECT 1 FROM app.enrollments e
                  WHERE e.org_id = u.org_id AND e.program_version_id = u.program_version_id AND e.student_id = app.actor_id())
          OR EXISTS (SELECT 1 FROM app.classroom_programs cp
                     JOIN app.student_profiles sp ON sp.org_id = cp.org_id AND sp.classroom_id = cp.classroom_id
                     WHERE cp.org_id = u.org_id AND cp.program_version_id = u.program_version_id AND sp.id = app.actor_id()))
      ) THEN
        RAISE EXCEPTION 'PROGRAM_NOT_ASSIGNED';
      END IF;
      -- docs/04 「設定変更は新規申請に適用」: the hold of a NEW request follows the organisation's current
      -- booking_pending_ttl_seconds (create_reservation reads the slot column); existing holds are untouched.
      SELECT CASE WHEN jsonb_typeof(o.settings -> 'booking_pending_ttl_seconds') = 'number'
                  THEN least(greatest(floor((o.settings ->> 'booking_pending_ttl_seconds')::numeric), 1), 1209600)::int END
        INTO v_ttl FROM app.organizations o WHERE o.id = app.org_id();
      IF v_ttl IS NOT NULL AND v_ttl <> s.pending_ttl_seconds THEN
        UPDATE app.lesson_slots SET pending_ttl_seconds = v_ttl WHERE org_id = app.org_id() AND id = p_slot;
      END IF;
    END IF;
  END IF;
  RETURN app.create_reservation(p_slot, p_key);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
