import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ClassroomEnrollmentInput, EnrollmentInput } from "@arms/contracts";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { InlineError } from "../../../components/ui/Feedback";
import { Field, Input, Select } from "../../../components/ui/Field";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import { useClassroomsLookup, type ActionResult, type DataResponse, type Enrollment, type ProgramVersion } from "../api";
import { versionLabel } from "../format";
import { StudentPicker, type PickedStudent } from "../StudentPicker";

function issuesToErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) out[i.path.map(String).join(".")] ??= i.message;
  return out;
}

function StudentEnrollmentForm({ version }: { version: ProgramVersion }) {
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const [dueOn, setDueOn] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Enrollment | null>(null);
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const mutation = useIdempotentMutation((body: unknown, key: string) => api.post<DataResponse<Enrollment>>("/enrollments", body, { idempotencyKey: key }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = EnrollmentInput.safeParse({ student_id: student?.id ?? "", program_version_id: version.id, due_on: dueOn });
    if (!parsed.success) {
      const errs = issuesToErrors(parsed.error.issues);
      if (!student) errs.student_id = "新入社員を選択してください。";
      setErrors(errs);
      return;
    }
    setErrors({});
    try {
      const res = await mutation.mutateAsync(parsed.data);
      setDone(res.data);
      toast.success("受講を割り当てました", `${student?.display_name}さんに ${res.data.program_name} ${versionLabel(res.data.version_number)} を割り当てました。`);
      void qc.invalidateQueries({ queryKey: ["learning"] });
      setStudent(null);
      setDueOn("");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    }
  };
  return (
    <form onSubmit={submit} noValidate aria-label="新入社員に割り当て" className="flex flex-col gap-3">
      <h3 className="text-sm font-bold">新入社員に割り当て</h3>
      <StudentPicker label="新入社員" required activeOnly value={student?.id ?? ""} onChange={setStudent} error={errors.student_id} />
      <Field label="修了期限" required error={errors.due_on}>
        {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
      </Field>
      <InlineError error={mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length) ? mutation.error : null} />
      {done ? (
        <p role="status" className="text-xs text-success">
          割当済み：<Link className="underline" to={`/progress/students/${done.student_id}`}>教育進捗を見る</Link>
        </p>
      ) : null}
      <div>
        <Button type="submit" loading={mutation.isPending} disabled={!online}>
          割り当てる
        </Button>
      </div>
    </form>
  );
}

function ClassroomEnrollmentForm({ version }: { version: ProgramVersion }) {
  const classrooms = useClassroomsLookup();
  const [classroomId, setClassroomId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ created: number; skipped: number; name: string } | null>(null);
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const mutation = useIdempotentMutation((input: { classroomId: string; body: unknown }, key: string) =>
    api.post<ActionResult>(`/classrooms/${input.classroomId}/enrollments`, input.body, { idempotencyKey: key }),
  );
  const options = (classrooms.data?.items ?? []).filter((c) => !c.archived);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ClassroomEnrollmentInput.safeParse({ program_version_id: version.id, due_on: dueOn });
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (!classroomId) errs.classroom_id = "クラスを選択してください。";
    setErrors(errs);
    if (!parsed.success || !classroomId) return;
    try {
      const res = await mutation.mutateAsync({ classroomId, body: parsed.data });
      const data = (res.data ?? {}) as { created?: number; skipped?: number };
      const name = options.find((c) => c.id === classroomId)?.name ?? "";
      setResult({ created: data.created ?? 0, skipped: data.skipped ?? 0, name });
      toast.success("クラスに一括で割り当てました", `${name}：新規 ${data.created ?? 0}名・対象外 ${data.skipped ?? 0}名`);
      void qc.invalidateQueries({ queryKey: ["learning"] });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    }
  };
  return (
    <form onSubmit={submit} noValidate aria-label="クラスに一括割り当て" className="flex flex-col gap-3">
      <h3 className="text-sm font-bold">クラスに一括割り当て</h3>
      <Field label="クラス" required error={errors.classroom_id} hint="在籍中の新入社員全員に割り当てます。既に受講中・停止中の新入社員は対象外です。">
        {(p) => (
          <Select {...p} value={classroomId} onChange={(e) => setClassroomId(e.target.value)}>
            <option value="">{classrooms.isLoading ? "読み込み中…" : "選択してください"}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（在籍 {c.student_count}名）
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="修了期限" required error={errors.due_on}>
        {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
      </Field>
      <InlineError error={mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length) ? mutation.error : null} />
      {result ? (
        <p role="status" className="text-xs">
          {result.name}：新しく {result.created}名に割り当てました（既に受講中などで対象外 {result.skipped}名）。
        </p>
      ) : null}
      <div>
        <Button type="submit" loading={mutation.isPending} disabled={!online}>
          一括で割り当てる
        </Button>
      </div>
    </form>
  );
}

/** 受講の割当: explicit assignment of the published version (weights and quiz policy are fixed per enrollment). */
export function EnrollmentPanel({ published }: { published: ProgramVersion }) {
  return (
    <Card aria-labelledby="enrollment-heading">
      <CardHeader
        id="enrollment-heading"
        title="受講の割当"
        description={`公開中の ${versionLabel(published.version_number)} を割り当てます。割り当てたバージョン（単元・重み・受験回数）は受講者ごとに固定され、後から新しいバージョンを公開しても変わりません。`}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <StudentEnrollmentForm version={published} />
        <ClassroomEnrollmentForm version={published} />
      </div>
    </Card>
  );
}
