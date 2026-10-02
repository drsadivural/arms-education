BEGIN;
CREATE TABLE app.idempotency_requests(org_id uuid NOT NULL,user_id uuid NOT NULL,route text NOT NULL,key uuid NOT NULL,request_hash text NOT NULL,response jsonb,status_code int CHECK(status_code BETWEEN 200 AND 599),created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',PRIMARY KEY(org_id,user_id,route,key),FOREIGN KEY(org_id,user_id) REFERENCES app.memberships);
CREATE TABLE app.user_preferences(org_id uuid NOT NULL,user_id uuid NOT NULL,theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('light','dark','system')),notifications_enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(org_id,user_id),FOREIGN KEY(org_id,user_id) REFERENCES app.memberships);
CREATE TABLE app.invitation_jobs(org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),email text NOT NULL,role text NOT NULL CHECK(role IN ('admin','teacher','student')),profile_payload jsonb NOT NULL,state text NOT NULL CHECK(state IN ('pending','auth_created','profile_created','sent','failed')),auth_user_id uuid,attempts int NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT now(),row_version int NOT NULL DEFAULT 1,PRIMARY KEY(org_id,id));
CREATE TABLE app.upload_jobs(org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),user_id uuid NOT NULL,purpose text NOT NULL CHECK(purpose IN ('material','assignment','import')),object_key text NOT NULL,filename text NOT NULL,content_type text NOT NULL,expected_size bigint NOT NULL CHECK(expected_size>0),scan_state text NOT NULL CHECK(scan_state IN ('pending','clean','blocked','not_applicable')),expires_at timestamptz NOT NULL,PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,user_id) REFERENCES app.memberships,UNIQUE(object_key));
CREATE TABLE app.export_jobs(org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),user_id uuid NOT NULL,format text NOT NULL CHECK(format IN ('csv','pdf')),filters jsonb NOT NULL,state text NOT NULL CHECK(state IN ('pending','ready','failed')),object_key text,expires_at timestamptz,PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,user_id) REFERENCES app.memberships);
CREATE TABLE app.account_deletion_requests(org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),user_id uuid NOT NULL,reason text NOT NULL DEFAULT '',state text NOT NULL CHECK(state IN ('requested','reviewing','completed')),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,user_id) REFERENCES app.memberships);
ALTER TABLE app.programs ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE app.program_versions ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE app.units ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE app.materials ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE app.submissions ADD COLUMN row_version int NOT NULL DEFAULT 1;
ALTER TABLE app.lesson_slots ADD COLUMN row_version int NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION app.guard_classroom_capacity() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE cap int;used int; BEGIN
 PERFORM 1 FROM app.classrooms WHERE org_id=NEW.org_id AND id=NEW.classroom_id FOR UPDATE;
 IF TG_OP='UPDATE' AND OLD.classroom_id<>NEW.classroom_id AND current_setting('app.allow_transfer',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'CLASSROOM_TRANSFER_REQUIRES_SERVICE'; END IF;
 IF NEW.active THEN SELECT capacity INTO cap FROM app.classrooms WHERE org_id=NEW.org_id AND id=NEW.classroom_id AND NOT archived;
 SELECT count(*) INTO used FROM app.student_profiles WHERE org_id=NEW.org_id AND classroom_id=NEW.classroom_id AND active AND id<>NEW.id;
 IF cap IS NULL OR used>=cap THEN RAISE EXCEPTION 'CLASSROOM_FULL'; END IF; END IF; RETURN NEW; END $$;
CREATE FUNCTION app.transfer_student(p_student uuid,p_classroom uuid,p_teacher uuid,p_version int,p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE s app.student_profiles;c uuid;BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE org_id=app.org_id() AND id=app.actor_id() AND active AND role='admin') THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
 SELECT * INTO s FROM app.student_profiles WHERE org_id=app.org_id() AND id=p_student;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 FOR c IN SELECT id FROM app.classrooms WHERE org_id=app.org_id() AND id IN(s.classroom_id,p_classroom) ORDER BY id LOOP PERFORM 1 FROM app.classrooms WHERE org_id=app.org_id() AND id=c FOR UPDATE;END LOOP;
 SELECT * INTO s FROM app.student_profiles WHERE org_id=app.org_id() AND id=p_student FOR UPDATE;
 IF s.row_version<>p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM app.reservations WHERE org_id=app.org_id() AND student_id=p_student AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'ACTIVE_RESERVATIONS';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.classroom_teachers ct JOIN app.memberships m ON m.org_id=ct.org_id AND m.id=ct.teacher_id WHERE ct.org_id=app.org_id() AND ct.classroom_id=p_classroom AND ct.teacher_id=p_teacher AND m.active AND m.role='teacher') THEN RAISE EXCEPTION 'TEACHER_CLASSROOM_MISMATCH';END IF;
 PERFORM set_config('app.allow_transfer','yes',true);
 UPDATE app.student_profiles SET classroom_id=p_classroom,teacher_id=p_teacher,row_version=row_version+1 WHERE org_id=app.org_id() AND id=p_student RETURNING * INTO s;
 PERFORM set_config('app.allow_transfer','no',true);
 INSERT INTO app.audit_events(org_id,actor_id,event_type,entity_id,payload) VALUES(app.org_id(),app.actor_id(),'student.transferred',p_student,jsonb_build_object('classroom_id',p_classroom,'teacher_id',p_teacher,'reason',p_reason));RETURN to_jsonb(s);END $$;
CREATE FUNCTION app.guard_classroom_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE used int;BEGIN
 SELECT count(*) INTO used FROM app.student_profiles WHERE org_id=OLD.org_id AND classroom_id=OLD.id AND active;
 IF NEW.capacity<used THEN RAISE EXCEPTION 'CAPACITY_BELOW_ENROLLMENT';END IF;
 IF NEW.archived AND NOT OLD.archived AND used>0 THEN RAISE EXCEPTION 'CLASSROOM_HAS_STUDENTS';END IF;RETURN NEW;END $$;
CREATE TRIGGER classroom_change_guard BEFORE UPDATE ON app.classrooms FOR EACH ROW EXECUTE FUNCTION app.guard_classroom_change();
CREATE FUNCTION app.guard_profile_role() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expected text;BEGIN
 expected:=CASE WHEN TG_TABLE_NAME='teacher_profiles' THEN 'teacher' ELSE 'student' END;
 IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE org_id=NEW.org_id AND id=NEW.id AND role=expected) THEN RAISE EXCEPTION 'PROFILE_ROLE_MISMATCH';END IF;RETURN NEW;END $$;
CREATE TRIGGER teacher_role_guard BEFORE INSERT OR UPDATE ON app.teacher_profiles FOR EACH ROW EXECUTE FUNCTION app.guard_profile_role();
CREATE TRIGGER student_role_guard BEFORE INSERT OR UPDATE ON app.student_profiles FOR EACH ROW EXECUTE FUNCTION app.guard_profile_role();
CREATE FUNCTION app.guard_published_material() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE o uuid;u uuid;BEGIN
 IF TG_OP='DELETE' THEN o:=OLD.org_id;u:=OLD.unit_id;ELSE o:=NEW.org_id;u:=NEW.unit_id;END IF;
 IF EXISTS(SELECT 1 FROM app.units x JOIN app.program_versions v ON x.org_id=v.org_id AND x.program_version_id=v.id WHERE x.org_id=o AND x.id=u AND v.state<>'draft') THEN RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE TRIGGER material_version_guard BEFORE INSERT OR UPDATE OR DELETE ON app.materials FOR EACH ROW EXECUTE FUNCTION app.guard_published_material();
CREATE FUNCTION app.guard_published_quiz() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE o uuid;m uuid;BEGIN
 IF TG_OP='DELETE' THEN o:=OLD.org_id;m:=OLD.material_id;ELSE o:=NEW.org_id;m:=NEW.material_id;END IF;
 IF EXISTS(SELECT 1 FROM app.materials a JOIN app.units u ON a.org_id=u.org_id AND a.unit_id=u.id JOIN app.program_versions v ON u.org_id=v.org_id AND u.program_version_id=v.id WHERE a.org_id=o AND a.id=m AND v.state<>'draft') THEN RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE TRIGGER quiz_version_guard BEFORE INSERT OR UPDATE OR DELETE ON app.quiz_questions FOR EACH ROW EXECUTE FUNCTION app.guard_published_quiz();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['idempotency_requests','user_preferences','invitation_jobs','upload_jobs','export_jobs','account_deletion_requests'] LOOP
 EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_scope ON app.%I USING(org_id=app.org_id()) WITH CHECK(org_id=app.org_id())',t);END LOOP;END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
