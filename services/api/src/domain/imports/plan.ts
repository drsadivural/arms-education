/**
 * Dry run: turns mapped CSV rows into planned import items (create / update / skip / error) with Japanese row
 * errors and warnings. Read-only: it never changes business tables.
 *
 * Matching rules (docs/08): people are matched by 講師番号 / 社員番号 only — same-name people are never merged
 * (a warning is shown instead); classrooms by the legacy クラス番号 recorded when they were imported; progress
 * records by (source_system, source_record_id). References (teacher / student / classroom numbers) must resolve to
 * records that already exist in ARMS — import the files in the order 講師 → クラス → 新入社員 → 教育進捗.
 * A record that was changed in ARMS after the previous import of the same record gets a warning in the dry run
 * (the diff shows the current ARMS values); between dry run and commit the row_version is checked again.
 */
import { PROGRESS_RECORD_STATE_LABELS, type ImportEntity, type ProgressRecordState } from "@arms/contracts";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";
import { COMPARE_FIELDS, fieldLabel, type ItemAction, type PlannedItem, type RowMessage, type SourceRow } from "./model";
import { cleanText, isEmail, parseActive, parseCount, parseImportDate, parseProgressState } from "./values";

export interface PlanContext {
  tx: Tx;
  orgId: string;
  sourceSystem: string;
  jobId: string;
}

const MAX_LENGTH: Record<string, number> = {
  teacher_number: 50,
  employee_number: 50,
  classroom_code: 50,
  primary_teacher_number: 50,
  source_record_id: 200,
  display_name: 100,
  kana: 100,
  email: 254,
  department_name: 100,
  company_name: 100,
  name: 100,
  teacher_name: 100,
  student_name: 100,
  content: 2000,
  notes: 5000,
};

/** Identifier cell (番号・コード・メール): NFKC (全角→半角) and trimmed. */
export function normalizeKey(raw: string): string {
  return raw.normalize("NFKC").trim();
}

const quote = (v: string) => `「${v.length > 40 ? `${v.slice(0, 40)}…` : v}」`;
const unique = (values: Iterable<string>) => [...new Set([...values].filter((v) => v !== ""))];

class Row {
  readonly errors: RowMessage[] = [];
  readonly warnings: RowMessage[] = [];

  constructor(
    readonly entity: ImportEntity,
    readonly src: SourceRow,
  ) {
    if (src.extraCells > 0) this.error("_row", "見出しより右の列に値があります。区切り文字（,）や引用符（\"）の位置を確認してください。");
  }

  label(field: string): string {
    return fieldLabel(this.entity, field);
  }

  error(field: string, message_ja: string): void {
    this.errors.push({ field, label_ja: this.label(field), message_ja });
  }

  warn(field: string, message_ja: string): void {
    this.warnings.push({ field, label_ja: this.label(field), message_ja });
  }

  mapped(field: string): boolean {
    return this.src.values.has(field);
  }

  /** undefined = column not mapped; "" = empty cell. Length limits are checked here. */
  text(field: string, opts: { required?: boolean; key?: boolean } = {}): string | undefined {
    if (!this.mapped(field)) return undefined;
    const raw = this.src.values.get(field) ?? "";
    const value = opts.key ? normalizeKey(raw) : cleanText(raw);
    if (opts.required && value === "") {
      this.error(field, `${this.label(field)}は必須です。`);
      return value;
    }
    const max = MAX_LENGTH[field];
    if (max !== undefined && value.length > max) this.error(field, `${this.label(field)}は${max}文字以内にしてください（${value.length}文字）。`);
    return value;
  }

  /** undefined = not mapped or empty (optional); null = invalid (error recorded). */
  date(field: string, required: boolean): string | null | undefined {
    const raw = this.text(field, { required });
    if (raw === undefined || raw === "") return required ? null : undefined;
    const parsed = parseImportDate(raw);
    if (parsed.ok) return parsed.value;
    const label = this.label(field);
    if (parsed.reason === "nonexistent") this.error(field, `${label}${quote(raw)}は存在しない日付です。`);
    else if (parsed.reason === "weekday") this.error(field, `${label}${quote(raw)}の曜日が日付と一致しません。`);
    else this.error(field, `${label}${quote(raw)}を日付として読み取れません。2019-08-31 または 2019年8月31日 の形式で入力してください。`);
    return null;
  }

  /** undefined = not mapped or empty; null = invalid (error recorded). */
  active(field: string, words: string): boolean | null | undefined {
    const raw = this.text(field);
    if (raw === undefined || raw === "") return undefined;
    const v = parseActive(raw);
    if (v === null) this.error(field, `${this.label(field)}${quote(raw)}を判別できません。${words}のいずれかを指定してください。`);
    return v;
  }

  email(field: string): string | undefined {
    const raw = this.text(field, { key: true });
    if (raw === undefined || raw === "") return raw;
    if (!isEmail(raw)) this.error(field, `メール${quote(raw)}の形式が正しくありません。`);
    return raw;
  }

  decide(changed: string[], editedSinceImport: boolean): ItemAction {
    if (this.errors.length > 0) return "error";
    if (changed.length === 0) return "skip";
    if (editedSinceImport) {
      this.warn("_row", "前回の移行の後にARMSで編集されています。確定するとこのファイルの値で上書きします。変更前の値を確認してください。");
    }
    return "update";
  }

  item(action: ItemAction, key: string, entityId: string | null, before: Record<string, unknown> | null, after: Record<string, unknown> | null): PlannedItem {
    return {
      row: this.src.row,
      action: this.errors.length > 0 ? "error" : action,
      key: key || null,
      entityId,
      before,
      after,
      errors: this.errors,
      warnings: this.warnings,
      source: this.src.source,
    };
  }
}

/** Rows of `items` whose key occurs more than once (key → row numbers). */
function duplicates<T>(items: T[], keyOf: (item: T) => string, rowOf: (item: T) => number): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    seen.set(key, [...(seen.get(key) ?? []), rowOf(item)]);
  }
  return new Map([...seen].filter(([, rows]) => rows.length > 1));
}

const rowList = (rows: number[]) => rows.map((r) => `${r}`).join("・");

function changedFields(entity: ImportEntity, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return COMPARE_FIELDS[entity].filter((f) => String(before[f] ?? "") !== String(after[f] ?? ""));
}

/**
 * Highest row_version an import operation left on each entity (commit or rollback restore). A current row_version
 * above it means someone edited the record in ARMS since; the dry run then warns before overwriting.
 */
async function importedVersions(ctx: PlanContext, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx.query<{ entity_id: string; version: number }>(sql`
    SELECT entity_id, max(greatest(committed_version, coalesce(reverted_version, 0)))::int AS version
    FROM app.import_items
    WHERE org_id = ${ctx.orgId} AND entity_id = ANY(${ids}::uuid[]) AND job_id <> ${ctx.jobId} AND commit_state = 'applied'
    GROUP BY entity_id`);
  return new Map(rows.map((r) => [r.entity_id, r.version]));
}

/** E-mail addresses already used by any account (accounts are global; never joined automatically). */
async function takenEmails(ctx: PlanContext, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await ctx.tx.query<{ email: string }>(sql`SELECT lower(email) AS email FROM app.users WHERE lower(email) = ANY(${emails}::text[])`);
  return new Set(rows.map((r) => r.email));
}

interface TeacherRef {
  id: string;
  teacher_number: string;
  display_name: string;
  active: boolean;
}

async function teachersByNumber(ctx: PlanContext, numbers: string[]): Promise<Map<string, TeacherRef>> {
  if (numbers.length === 0) return new Map();
  const rows = await ctx.tx.query<TeacherRef>(sql`
    SELECT tp.id, tp.teacher_number, u.display_name, m.active
    FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id JOIN app.users u ON u.id = tp.id
    WHERE tp.org_id = ${ctx.orgId} AND tp.teacher_number = ANY(${numbers}::text[])`);
  return new Map(rows.map((r) => [r.teacher_number, r]));
}

function emailRules(
  r: Row,
  email: string | undefined,
  dupEmails: Map<string, number[]>,
  taken: Set<string>,
): void {
  if (email === undefined || email === "" || r.errors.some((e) => e.field === "email")) return;
  const lower = email.toLowerCase();
  const dup = dupEmails.get(lower);
  if (dup) r.error("email", `メール${quote(email)}がファイル内で重複しています（${rowList(dup)}行目）。`);
  else if (taken.has(lower)) r.error("email", `メール${quote(email)}は既に別のアカウントで使われています。別人のアカウントとは自動で結合しません。`);
}

// ---- 講師 ------------------------------------------------------------------------------------------

async function planTeachers(ctx: PlanContext, rows: SourceRow[]): Promise<PlannedItem[]> {
  const parsed = rows.map((src) => {
    const r = new Row("teachers", src);
    return {
      r,
      number: r.text("teacher_number", { required: true, key: true }) ?? "",
      displayName: r.text("display_name", { required: true }) ?? "",
      kana: r.text("kana"),
      email: r.email("email"),
      department: r.text("department_name"),
      active: r.active("active", "有効・無効"),
    };
  });
  const existing = new Map(
    (
      await ctx.tx.query<{ id: string; teacher_number: string; display_name: string; email: string; kana: string; department_name: string; active: boolean; row_version: number }>(sql`
        SELECT tp.id, tp.teacher_number, u.display_name, u.email, tp.kana, tp.department_name, m.active, tp.row_version
        FROM app.teacher_profiles tp JOIN app.memberships m ON m.org_id = tp.org_id AND m.id = tp.id JOIN app.users u ON u.id = tp.id
        WHERE tp.org_id = ${ctx.orgId} AND tp.teacher_number = ANY(${unique(parsed.map((p) => p.number))}::text[])`)
    ).map((t) => [t.teacher_number, t]),
  );
  const imported = await importedVersions(ctx, [...existing.values()].map((t) => t.id));
  const newRows = parsed.filter((p) => !existing.has(p.number));
  const taken = await takenEmails(ctx, unique(newRows.map((p) => (p.email ?? "").toLowerCase())));
  const dupNumbers = duplicates(parsed, (p) => p.number, (p) => p.r.src.row);
  const dupEmails = duplicates(newRows, (p) => (p.email ?? "").toLowerCase(), (p) => p.r.src.row);
  const sameName = await ctx.tx.query<{ teacher_number: string; display_name: string }>(sql`
    SELECT tp.teacher_number, u.display_name FROM app.teacher_profiles tp JOIN app.users u ON u.id = tp.id
    WHERE tp.org_id = ${ctx.orgId} AND u.display_name = ANY(${unique(newRows.map((p) => p.displayName))}::text[])`);
  const fileNames = duplicates(parsed, (p) => p.displayName, (p) => p.r.src.row);

  return parsed.map(({ r, number, displayName, kana, email, department, active }) => {
    const dup = dupNumbers.get(number);
    if (dup) r.error("teacher_number", `講師番号${quote(number)}がファイル内で重複しています（${rowList(dup)}行目）。`);
    const current = existing.get(number);
    if (current) {
      if (email && email.toLowerCase() !== current.email.toLowerCase()) {
        r.error("email", `メールアドレスはログインIDのため移行では変更できません（登録済み: ${current.email}）。`);
      }
      if (active !== undefined && active !== null && active !== current.active) {
        r.error("active", "登録済みの講師の有効・停止は移行では変更しません。講師管理から変更してください。");
      }
      const before = { ...current };
      const after = {
        teacher_number: number,
        display_name: displayName,
        kana: kana ?? current.kana,
        email: current.email,
        department_name: department ?? current.department_name,
        active: current.active,
      };
      const changed = changedFields("teachers", before, after);
      const edited = imported.has(current.id) && (imported.get(current.id) ?? 0) < current.row_version;
      return r.item(r.decide(changed, edited), number, current.id, before, after);
    }
    if (!r.mapped("email") || email === "") r.error("email", "新しく登録する講師にはメールが必須です（ログインID・招待先）。");
    emailRules(r, email, dupEmails, taken);
    const others = sameName.filter((t) => t.display_name === displayName && t.teacher_number !== number).map((t) => t.teacher_number);
    const inFile = (fileNames.get(displayName) ?? []).filter((row) => row !== r.src.row);
    if (displayName && (others.length > 0 || inFile.length > 0)) {
      const where = [...others.map((n) => `講師番号${n}`), ...inFile.map((row) => `${row}行目`)].join("・");
      r.warn("display_name", `同姓同名の講師（${where}）がいます。講師番号が異なるため別人として登録します。`);
    }
    const after = { teacher_number: number, display_name: displayName, kana: kana ?? "", email: email ?? "", department_name: department ?? "", active: active ?? true };
    return r.item("create", number, null, null, after);
  });
}

// ---- クラス ----------------------------------------------------------------------------------------

async function planClassrooms(ctx: PlanContext, rows: SourceRow[]): Promise<PlannedItem[]> {
  const parsed = rows.map((src) => {
    const r = new Row("classrooms", src);
    const code = r.text("classroom_code", { required: true, key: true }) ?? "";
    const name = r.text("name", { required: true }) ?? "";
    const capacityRaw = r.text("capacity", { required: true }) ?? "";
    let capacity: number | null = null;
    if (capacityRaw !== "") {
      capacity = parseCount(capacityRaw, 1, 10000);
      if (capacity === null) r.error("capacity", `定員${quote(capacityRaw)}は1〜10,000の整数で入力してください。`);
    }
    const startsOn = r.date("starts_on", true);
    const endsOn = r.date("ends_on", true);
    if (startsOn && endsOn && endsOn < startsOn) r.error("ends_on", "終了日は開始日以降にしてください。");
    const teacherNumber = r.text("primary_teacher_number", { required: true, key: true }) ?? "";
    return { r, code, name, capacity, startsOn, endsOn, teacherNumber };
  });
  const existing = new Map(
    (
      await ctx.tx.query<{
        classroom_code: string;
        id: string;
        name: string;
        capacity: number;
        starts_on: string;
        ends_on: string;
        archived: boolean;
        row_version: number;
        primary_teacher_id: string | null;
        primary_teacher_number: string | null;
        primary_teacher_name: string | null;
        active_students: number;
      }>(sql`
        SELECT k.classroom_code, c.id, c.name, c.capacity, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
          c.archived, c.row_version, pt.teacher_id AS primary_teacher_id, ptp.teacher_number AS primary_teacher_number, pu.display_name AS primary_teacher_name,
          (SELECT count(*)::int FROM app.student_profiles sp WHERE sp.org_id = c.org_id AND sp.classroom_id = c.id AND sp.active) AS active_students
        FROM app.import_classroom_keys k
        JOIN app.classrooms c ON c.org_id = k.org_id AND c.id = k.classroom_id
        LEFT JOIN app.classroom_teachers pt ON pt.org_id = c.org_id AND pt.classroom_id = c.id AND pt.is_primary
        LEFT JOIN app.teacher_profiles ptp ON ptp.org_id = pt.org_id AND ptp.id = pt.teacher_id
        LEFT JOIN app.users pu ON pu.id = pt.teacher_id
        WHERE k.org_id = ${ctx.orgId} AND k.source_system = ${ctx.sourceSystem} AND k.classroom_code = ANY(${unique(parsed.map((p) => p.code))}::text[])`)
    ).map((c) => [c.classroom_code, c]),
  );
  const imported = await importedVersions(ctx, [...existing.values()].map((c) => c.id));
  const teachers = await teachersByNumber(ctx, unique(parsed.map((p) => p.teacherNumber)));
  const named = await ctx.tx.query<{ id: string; name: string; starts_on: string }>(sql`
    SELECT id, name, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM app.classrooms
    WHERE org_id = ${ctx.orgId} AND name = ANY(${unique(parsed.map((p) => p.name))}::text[])`);
  const dupCodes = duplicates(parsed, (p) => p.code, (p) => p.r.src.row);
  const dupNames = duplicates(parsed, (p) => (p.name && p.startsOn ? `${p.name}\u0000${p.startsOn}` : ""), (p) => p.r.src.row);

  return parsed.map(({ r, code, name, capacity, startsOn, endsOn, teacherNumber }) => {
    const dup = dupCodes.get(code);
    if (dup) r.error("classroom_code", `クラス番号${quote(code)}がファイル内で重複しています（${rowList(dup)}行目）。`);
    const teacher = teacherNumber ? teachers.get(teacherNumber) : undefined;
    if (teacherNumber && !teacher) {
      r.error("primary_teacher_number", `講師番号${quote(teacherNumber)}の講師が未登録です。先に講師を移行・登録するか、項目の対応を修正してください。`);
    } else if (teacher && !teacher.active) {
      r.error("primary_teacher_number", `講師番号${quote(teacherNumber)}の講師は停止中のため主担当にできません。`);
    }
    const current = existing.get(code);
    const nameRows = name && startsOn ? dupNames.get(`${name}\u0000${startsOn}`) : undefined;
    if (nameRows) r.error("name", `同じ名称・開始日のクラス${quote(name)}がファイル内で重複しています（${rowList(nameRows)}行目）。`);
    else if (name && startsOn && named.some((c) => c.name === name && c.starts_on === startsOn && c.id !== current?.id)) {
      r.error("name", `同じ名称・開始日のクラス${quote(name)}が既に登録されています（クラス番号の対応がないため自動で結合しません）。`);
    }
    const after = {
      classroom_code: code,
      name,
      capacity,
      starts_on: startsOn ?? null,
      ends_on: endsOn ?? null,
      primary_teacher_id: teacher?.id ?? null,
      primary_teacher_number: teacherNumber,
      primary_teacher_name: teacher?.display_name ?? null,
    };
    if (current) {
      if (current.archived) r.error("classroom_code", `クラス${quote(current.name)}はアーカイブ済みのため更新できません。`);
      if (teacher && current.primary_teacher_id !== teacher.id) {
        r.error("primary_teacher_number", `主担当講師の変更（${current.primary_teacher_number ?? "なし"} → ${teacherNumber}）はクラスルーム管理から行ってください。`);
      }
      if (capacity !== null && capacity < current.active_students) {
        r.error("capacity", `定員${capacity}名は現在の在籍人数（${current.active_students}名）より少ないため変更できません。`);
      }
      const before = { ...current };
      const changed = changedFields("classrooms", before, after);
      const edited = imported.has(current.id) && (imported.get(current.id) ?? 0) < current.row_version;
      return r.item(r.decide(changed, edited), code, current.id, before, after);
    }
    return r.item("create", code, null, null, after);
  });
}

// ---- 新入社員 --------------------------------------------------------------------------------------

interface ClassroomRef {
  classroom_code: string;
  id: string;
  name: string;
  capacity: number;
  starts_on: string;
  ends_on: string;
  archived: boolean;
  active_students: number;
}

async function planStudents(ctx: PlanContext, rows: SourceRow[]): Promise<PlannedItem[]> {
  const parsed = rows.map((src) => {
    const r = new Row("students", src);
    return {
      r,
      number: r.text("employee_number", { required: true, key: true }) ?? "",
      displayName: r.text("display_name", { required: true }) ?? "",
      kana: r.text("kana"),
      email: r.email("email"),
      company: r.text("company_name"),
      department: r.text("department_name", { required: true }) ?? "",
      joinedOn: r.date("joined_on", true),
      classroomCode: r.text("classroom_code", { required: true, key: true }) ?? "",
      teacherNumber: r.text("teacher_number", { required: true, key: true }) ?? "",
      startsOn: r.date("training_starts_on", false),
      dueOn: r.date("training_due_on", false),
      active: r.active("active", "在籍・在籍終了"),
    };
  });
  type Existing = {
    id: string;
    employee_number: string;
    display_name: string;
    kana: string;
    email: string;
    company_name: string;
    department_name: string;
    joined_on: string;
    classroom_id: string;
    teacher_id: string;
    training_starts_on: string;
    training_due_on: string;
    active: boolean;
    row_version: number;
  };
  const existing = new Map(
    (
      await ctx.tx.query<Existing>(sql`
        SELECT sp.id, sp.employee_number, u.display_name, sp.kana, u.email, sp.company_name, sp.department_name,
          to_char(sp.joined_on, 'YYYY-MM-DD') AS joined_on, sp.classroom_id, sp.teacher_id,
          to_char(sp.training_starts_on, 'YYYY-MM-DD') AS training_starts_on, to_char(sp.training_due_on, 'YYYY-MM-DD') AS training_due_on,
          sp.active, sp.row_version
        FROM app.student_profiles sp JOIN app.users u ON u.id = sp.id
        WHERE sp.org_id = ${ctx.orgId} AND sp.employee_number = ANY(${unique(parsed.map((p) => p.number))}::text[])`)
    ).map((s) => [s.employee_number, s]),
  );
  const imported = await importedVersions(ctx, [...existing.values()].map((s) => s.id));
  const classrooms = new Map(
    (
      await ctx.tx.query<ClassroomRef>(sql`
        SELECT k.classroom_code, c.id, c.name, c.capacity, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on, c.archived,
          (SELECT count(*)::int FROM app.student_profiles sp WHERE sp.org_id = c.org_id AND sp.classroom_id = c.id AND sp.active) AS active_students
        FROM app.import_classroom_keys k JOIN app.classrooms c ON c.org_id = k.org_id AND c.id = k.classroom_id
        WHERE k.org_id = ${ctx.orgId} AND k.source_system = ${ctx.sourceSystem} AND k.classroom_code = ANY(${unique(parsed.map((p) => p.classroomCode))}::text[])`)
    ).map((c) => [c.classroom_code, c]),
  );
  const teachers = await teachersByNumber(ctx, unique(parsed.map((p) => p.teacherNumber)));
  const classroomIds = [...classrooms.values()].map((c) => c.id);
  const pairs = new Set(
    (
      await ctx.tx.query<{ classroom_id: string; teacher_id: string }>(sql`
        SELECT classroom_id, teacher_id FROM app.classroom_teachers WHERE org_id = ${ctx.orgId} AND classroom_id = ANY(${classroomIds}::uuid[])`)
    ).map((p) => `${p.classroom_id}:${p.teacher_id}`),
  );
  const newRows = parsed.filter((p) => !existing.has(p.number));
  const taken = await takenEmails(ctx, unique(newRows.map((p) => (p.email ?? "").toLowerCase())));
  const dupNumbers = duplicates(parsed, (p) => p.number, (p) => p.r.src.row);
  const dupEmails = duplicates(newRows, (p) => (p.email ?? "").toLowerCase(), (p) => p.r.src.row);
  const sameName = await ctx.tx.query<{ employee_number: string; display_name: string }>(sql`
    SELECT sp.employee_number, u.display_name FROM app.student_profiles sp JOIN app.users u ON u.id = sp.id
    WHERE sp.org_id = ${ctx.orgId} AND u.display_name = ANY(${unique(newRows.map((p) => p.displayName))}::text[])`);
  const fileNames = duplicates(parsed, (p) => p.displayName, (p) => p.r.src.row);

  const items = parsed.map((p) => {
    const { r, number, displayName, kana, email, company, department, joinedOn, classroomCode, teacherNumber, active } = p;
    const dup = dupNumbers.get(number);
    if (dup) r.error("employee_number", `社員番号${quote(number)}がファイル内で重複しています（${rowList(dup)}行目）。`);
    const classroom = classroomCode ? classrooms.get(classroomCode) : undefined;
    if (classroomCode && !classroom) r.error("classroom_code", `クラス番号${quote(classroomCode)}のクラスが見つかりません。先にクラスを移行してください（移行元システム名も同じにしてください）。`);
    else if (classroom?.archived) r.error("classroom_code", `クラス${quote(classroom.name)}はアーカイブ済みです。`);
    const teacher = teacherNumber ? teachers.get(teacherNumber) : undefined;
    if (teacherNumber && !teacher) r.error("teacher_number", `講師番号${quote(teacherNumber)}の講師が未登録です。先に講師を移行・登録してください。`);
    else if (teacher && !teacher.active) r.error("teacher_number", `講師番号${quote(teacherNumber)}の講師は停止中のため担当にできません。`);
    else if (teacher && classroom && !pairs.has(`${classroom.id}:${teacher.id}`)) {
      r.error("teacher_number", `講師番号${quote(teacherNumber)}の講師はクラス${quote(classroom.name)}の担当ではありません。`);
    }
    // Empty or unmapped training dates default to the classroom period (existing students: unmapped = unchanged).
    const current = existing.get(number);
    const resolve = (value: string | null | undefined, field: string, fallback: string | null) => {
      if (value === null) return null;
      if (value !== undefined) return value;
      if (current && !r.mapped(field)) return current[field as "training_starts_on" | "training_due_on"];
      return fallback;
    };
    const startsOn = resolve(p.startsOn, "training_starts_on", classroom?.starts_on ?? null);
    const dueOn = resolve(p.dueOn, "training_due_on", classroom?.ends_on ?? null);
    if (startsOn && dueOn && dueOn < startsOn) r.error(p.dueOn ? "training_due_on" : "training_starts_on", "研修終了予定日は研修開始日以降にしてください。");

    if (current) {
      if (email && email.toLowerCase() !== current.email.toLowerCase()) {
        r.error("email", `メールアドレスはログインIDのため移行では変更できません（登録済み: ${current.email}）。`);
      }
      if (active !== undefined && active !== null && active !== current.active) {
        r.error("active", "登録済みの社員の在籍状態は移行では変更しません。新入社員管理から変更してください。");
      }
      if ((classroom && classroom.id !== current.classroom_id) || (teacher && teacher.id !== current.teacher_id)) {
        r.error("classroom_code", "クラス・担当講師の変更は新入社員管理の「クラス移動」から理由を付けて行ってください。");
      }
      const before = { ...current, classroom_code: classroomCode, teacher_number: teacherNumber };
      const after = {
        employee_number: number,
        display_name: displayName,
        kana: kana ?? current.kana,
        email: current.email,
        company_name: company ?? current.company_name,
        department_name: department,
        joined_on: joinedOn ?? current.joined_on,
        classroom_id: current.classroom_id,
        classroom_code: classroomCode,
        classroom_name: classroom?.name ?? null,
        teacher_id: current.teacher_id,
        teacher_number: teacherNumber,
        teacher_name: teacher?.display_name ?? null,
        training_starts_on: startsOn,
        training_due_on: dueOn,
        active: current.active,
      };
      const changed = changedFields("students", before, after);
      const edited = imported.has(current.id) && (imported.get(current.id) ?? 0) < current.row_version;
      return { p, item: r.item(r.decide(changed, edited), number, current.id, before, after) };
    }
    if (!r.mapped("email") || email === "") r.error("email", "新しく登録する社員にはメールが必須です（ログインID・招待先）。");
    emailRules(r, email, dupEmails, taken);
    const others = sameName.filter((s) => s.display_name === displayName && s.employee_number !== number).map((s) => s.employee_number);
    const inFile = (fileNames.get(displayName) ?? []).filter((row) => row !== r.src.row);
    if (displayName && (others.length > 0 || inFile.length > 0)) {
      const where = [...others.map((n) => `社員番号${n}`), ...inFile.map((row) => `${row}行目`)].join("・");
      r.warn("display_name", `同姓同名の社員（${where}）がいます。社員番号が異なるため別人として登録します。`);
    }
    const after = {
      employee_number: number,
      display_name: displayName,
      kana: kana ?? "",
      email: email ?? "",
      company_name: company ?? "",
      department_name: department,
      joined_on: joinedOn ?? null,
      classroom_id: classroom?.id ?? null,
      classroom_code: classroomCode,
      classroom_name: classroom?.name ?? null,
      teacher_id: teacher?.id ?? null,
      teacher_number: teacherNumber,
      teacher_name: teacher?.display_name ?? null,
      training_starts_on: startsOn,
      training_due_on: dueOn,
      active: active ?? true,
    };
    return { p, item: r.item("create", number, null, null, after), classroom };
  });

  // Seats: new active students are counted in row order against the classroom capacity (rows with other errors
  // do not take a seat).
  const used = new Map<string, number>();
  for (const entry of items) {
    const { item } = entry;
    const classroom = "classroom" in entry ? entry.classroom : undefined;
    if (item.action !== "create" || !classroom || item.after?.active !== true) continue;
    const n = (used.get(classroom.id) ?? classroom.active_students) + 1;
    used.set(classroom.id, n);
    if (n > classroom.capacity) {
      entry.p.r.error("classroom_code", `クラス${quote(classroom.name)}の定員（${classroom.capacity}名）を超えます（在籍${classroom.active_students}名）。`);
      item.action = "error";
    }
  }
  return items.map((e) => e.item);
}

// ---- 教育進捗（旧システム） ----------------------------------------------------------------------

async function planProgress(ctx: PlanContext, rows: SourceRow[]): Promise<PlannedItem[]> {
  const parsed = rows.map((src) => {
    const r = new Row("progress", src);
    const stateRaw = r.text("state");
    let state: ProgressRecordState | null | undefined;
    if (stateRaw !== undefined) {
      state = parseProgressState(stateRaw);
      if (state === null) {
        const words = Object.values(PROGRESS_RECORD_STATE_LABELS).join("・");
        r.error("state", `学習完了状態${quote(stateRaw)}を判別できません。${words}のいずれかを指定してください（空欄は未確認）。`);
      }
    }
    return {
      r,
      sourceId: r.text("source_record_id", { required: true, key: true }) ?? "",
      employeeNumber: r.text("employee_number", { required: true, key: true }) ?? "",
      studentName: r.text("student_name"),
      dueDate: r.date("due_date", true),
      department: r.text("department_name", { required: true }) ?? "",
      teacherNumber: r.text("teacher_number", { required: true, key: true }) ?? "",
      teacherName: r.text("teacher_name"),
      content: r.text("content", { required: true }) ?? "",
      notes: r.text("notes"),
      state,
    };
  });
  type Existing = {
    id: string;
    source_record_id: string;
    student_id: string;
    employee_number: string;
    student_name: string;
    teacher_id: string;
    teacher_number: string;
    department_name: string;
    teacher_name_snapshot: string;
    due_date: string;
    content: string;
    notes: string;
    state: ProgressRecordState;
    row_version: number;
  };
  const existing = new Map(
    (
      await ctx.tx.query<Existing>(sql`
        SELECT p.id, p.source_record_id, p.student_id, sp.employee_number, su.display_name AS student_name, p.teacher_id, tp.teacher_number,
          p.department_name, p.teacher_name_snapshot, to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.content, p.notes, p.state, p.row_version
        FROM app.progress_records p
        JOIN app.student_profiles sp ON sp.org_id = p.org_id AND sp.id = p.student_id JOIN app.users su ON su.id = p.student_id
        JOIN app.teacher_profiles tp ON tp.org_id = p.org_id AND tp.id = p.teacher_id
        WHERE p.org_id = ${ctx.orgId} AND p.source_system = ${ctx.sourceSystem} AND p.source_record_id = ANY(${unique(parsed.map((p) => p.sourceId))}::text[])`)
    ).map((p) => [p.source_record_id, p]),
  );
  const imported = await importedVersions(ctx, [...existing.values()].map((p) => p.id));
  const students = new Map(
    (
      await ctx.tx.query<{ id: string; employee_number: string; display_name: string }>(sql`
        SELECT sp.id, sp.employee_number, u.display_name FROM app.student_profiles sp JOIN app.users u ON u.id = sp.id
        WHERE sp.org_id = ${ctx.orgId} AND sp.employee_number = ANY(${unique(parsed.map((p) => p.employeeNumber))}::text[])`)
    ).map((s) => [s.employee_number, s]),
  );
  const teachers = await teachersByNumber(ctx, unique(parsed.map((p) => p.teacherNumber)));
  const dupIds = duplicates(parsed, (p) => p.sourceId, (p) => p.r.src.row);

  return parsed.map(({ r, sourceId, employeeNumber, studentName, dueDate, department, teacherNumber, teacherName, content, notes, state }) => {
    const dup = dupIds.get(sourceId);
    if (dup) r.error("source_record_id", `旧システムのレコードID${quote(sourceId)}がファイル内で重複しています（${rowList(dup)}行目）。`);
    const student = employeeNumber ? students.get(employeeNumber) : undefined;
    if (employeeNumber && !student) r.error("employee_number", `社員番号${quote(employeeNumber)}の社員が未登録です。先に新入社員を移行・登録してください。`);
    if (student && studentName && studentName !== student.display_name) {
      r.warn("student_name", `社員名${quote(studentName)}と社員番号${employeeNumber}の登録名${quote(student.display_name)}が異なります。社員番号で照合します。`);
    }
    const teacher = teacherNumber ? teachers.get(teacherNumber) : undefined;
    if (teacherNumber && !teacher) r.error("teacher_number", `講師番号${quote(teacherNumber)}の講師が未登録です。講師を登録するか、項目の対応を修正してください。`);
    if (teacher && teacherName && teacherName !== teacher.display_name) {
      r.warn("teacher_name", `教育担当者${quote(teacherName)}と講師番号${teacherNumber}の登録名${quote(teacher.display_name)}が異なります。旧システムの名前をそのまま記録します。`);
    }
    const current = existing.get(sourceId);
    const after = {
      source_record_id: sourceId,
      student_id: student?.id ?? null,
      employee_number: employeeNumber,
      student_name: student?.display_name ?? studentName ?? null,
      due_date: dueDate ?? null,
      department_name: department,
      teacher_id: teacher?.id ?? null,
      teacher_number: teacherNumber,
      // Unmapped 教育担当者 keeps the recorded snapshot while the teacher is unchanged; empty = the registered name.
      teacher_name_snapshot:
        teacherName || (teacherName === undefined && current && current.teacher_id === teacher?.id ? current.teacher_name_snapshot : (teacher?.display_name ?? "")),
      content,
      notes: notes ?? current?.notes ?? "",
      state: state ?? current?.state ?? "unverified",
    };
    if (current) {
      const before = { ...current };
      const changed = changedFields("progress", before, after);
      const edited = imported.has(current.id) && (imported.get(current.id) ?? 0) < current.row_version;
      return r.item(r.decide(changed, edited), sourceId, current.id, before, after);
    }
    return r.item("create", sourceId, null, null, after);
  });
}

export async function planRows(entity: ImportEntity, ctx: PlanContext, rows: SourceRow[]): Promise<PlannedItem[]> {
  switch (entity) {
    case "teachers":
      return planTeachers(ctx, rows);
    case "classrooms":
      return planClassrooms(ctx, rows);
    case "students":
      return planStudents(ctx, rows);
    case "progress":
      return planProgress(ctx, rows);
  }
}
