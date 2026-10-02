BEGIN;
CREATE FUNCTION app.emit_booking(p_org uuid,p_id uuid,p_event text,p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO app.audit_events(org_id,actor_id,event_type,entity_id,payload) VALUES(p_org,app.actor_id(),p_event,p_id,p_payload);
 INSERT INTO app.outbox(org_id,event_type,entity_id,payload) VALUES(p_org,p_event,p_id,p_payload);
END $$;
CREATE FUNCTION app.expire_slot(p_slot uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE r record;BEGIN
 FOR r IN UPDATE app.reservations SET status='expired',row_version=row_version+1,updated_at=now() WHERE org_id=app.org_id() AND slot_id=p_slot AND status='pending' AND expires_at<=now() RETURNING id LOOP
 PERFORM app.emit_booking(app.org_id(),r.id,'reservation.expired',jsonb_build_object('status','expired')); END LOOP;END $$;
CREATE FUNCTION app.create_reservation(p_slot uuid,p_key uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s app.lesson_slots;r app.reservations;sp app.student_profiles;role_name text;n int;BEGIN
 SELECT role INTO role_name FROM app.memberships WHERE org_id=app.org_id() AND id=app.actor_id() AND active;
 IF role_name IS DISTINCT FROM 'student' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(app.org_id()::text||app.actor_id()::text||p_key::text,0));
 SELECT * INTO r FROM app.reservations WHERE org_id=app.org_id() AND student_id=app.actor_id() AND idempotency_key=p_key;
 IF FOUND THEN IF r.slot_id<>p_slot THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN to_jsonb(r);END IF;
 SELECT * INTO s FROM app.lesson_slots WHERE org_id=app.org_id() AND id=p_slot FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM app.expire_slot(p_slot);
 IF s.state<>'open' OR s.booking_closes_at<=now() OR s.starts_at<=now() THEN RAISE EXCEPTION 'BOOKING_CLOSED';END IF;
 SELECT * INTO sp FROM app.student_profiles WHERE org_id=app.org_id() AND id=app.actor_id() AND active;
 IF NOT FOUND OR sp.classroom_id<>s.classroom_id THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT count(*) INTO n FROM app.reservations WHERE org_id=app.org_id() AND slot_id=p_slot AND status IN ('pending','approved');
 IF n>=s.capacity THEN RAISE EXCEPTION 'SLOT_FULL';END IF;
 INSERT INTO app.reservations(org_id,slot_id,student_id,starts_at,ends_at,status,expires_at,idempotency_key)
 VALUES(app.org_id(),p_slot,app.actor_id(),s.starts_at,s.ends_at,'pending',least(now()+s.pending_ttl_seconds*interval '1 second',s.starts_at),p_key) RETURNING * INTO r;
 PERFORM app.emit_booking(app.org_id(),r.id,'reservation.created',jsonb_build_object('status',r.status,'slot_id',s.id,'student_id',r.student_id));
 RETURN to_jsonb(r);END $$;
CREATE FUNCTION app.change_reservation(p_id uuid,p_action text,p_reason text,p_expected_version int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r app.reservations;s app.lesson_slots;role_name text;target text;BEGIN
 SELECT role INTO role_name FROM app.memberships WHERE org_id=app.org_id() AND id=app.actor_id() AND active;
 IF role_name IS NULL THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO r FROM app.reservations WHERE org_id=app.org_id() AND id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO s FROM app.lesson_slots WHERE org_id=app.org_id() AND id=r.slot_id FOR UPDATE;
 IF p_action='cancel' THEN IF r.student_id<>app.actor_id() OR role_name<>'student' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 ELSE IF role_name<>'admin' AND NOT(role_name='teacher' AND s.teacher_id=app.actor_id()) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;END IF;
 PERFORM app.expire_slot(s.id);
 SELECT * INTO r FROM app.reservations WHERE org_id=app.org_id() AND id=p_id FOR UPDATE;
 IF p_expected_version IS NULL OR r.row_version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF p_action='approve' THEN IF r.status<>'pending' OR s.starts_at<=now() OR s.state='cancelled' THEN RAISE EXCEPTION 'INVALID_STATE';END IF;target:='approved';
 ELSIF p_action='reject' THEN IF r.status<>'pending' THEN RAISE EXCEPTION 'INVALID_STATE';END IF;target:='rejected';
 ELSIF p_action='cancel' THEN IF r.status NOT IN ('pending','approved') OR now()>=s.starts_at-s.cancel_before_seconds*interval '1 second' THEN RAISE EXCEPTION 'CANCELLATION_CLOSED';END IF;target:='cancelled';
 ELSIF p_action='remove' THEN IF r.status='removed' THEN RETURN to_jsonb(r);END IF;target:='removed';
 ELSE RAISE EXCEPTION 'INVALID_ACTION';END IF;
 IF p_action IN ('reject','remove') AND (p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 1000) THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
 UPDATE app.reservations SET status=target,reason=p_reason,row_version=row_version+1,updated_at=now() WHERE org_id=app.org_id() AND id=p_id RETURNING * INTO r;
 PERFORM app.emit_booking(app.org_id(),r.id,'reservation.'||target,jsonb_build_object('status',target,'reason',p_reason,'student_id',r.student_id));
 RETURN to_jsonb(r);END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
