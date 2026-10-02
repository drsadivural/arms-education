import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeachersPage } from "../src/pages/teachers/TeachersPage";
import { TeacherFormPage } from "../src/pages/teachers/TeacherFormPage";
import { StudentFormPage } from "../src/pages/students/StudentFormPage";
import { StudentsPage } from "../src/pages/students/StudentsPage";
import { DashboardPage } from "../src/pages/dashboard/DashboardPage";
import { SettingsPage } from "../src/pages/settings/SettingsPage";
import { ClassroomDetailPage } from "../src/pages/classrooms/ClassroomDetailPage";
import type { Classroom, Dashboard, Student, Teacher } from "../src/features/admin/types";
import { CHECKED_AT, mockApi, page, renderPage } from "./admin-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CLS_A = "11111111-1111-4111-8111-111111111111";
const CLS_B = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";

const teacher = (over: Partial<Teacher> = {}): Teacher => ({
  id: T1,
  display_name: "田中 祥司",
  kana: "たなか しょうじ",
  email: "tanaka@example.invalid",
  teacher_number: "T001",
  department_name: "開発部",
  specialties: ["IT基礎"],
  availability: null,
  classroom_ids: [CLS_A],
  classrooms: [{ id: CLS_A, name: "Aクラス", is_primary: true }],
  student_count: 4,
  active: true,
  invitation_state: "sent",
  row_version: 3,
  ...over,
});

const classroom = (over: Partial<Classroom> = {}): Classroom => ({
  id: CLS_A,
  name: "Aクラス",
  capacity: 30,
  starts_on: "2026-10-01",
  ends_on: "2026-12-31",
  primary_teacher_id: T1,
  primary_teacher_name: "田中 祥司",
  assistant_teacher_ids: [],
  program_version_ids: [],
  programs: [],
  student_count: 24,
  average_progress_percent: 80,
  archived: false,
  row_version: 1,
  ...over,
});

const student = (over: Partial<Student> = {}): Student => ({
  id: "55555555-5555-4555-8555-555555555555",
  employee_number: "E001",
  display_name: "和田 一夫",
  kana: "わだ かずお",
  email: "wada@example.invalid",
  company_name: "",
  department_name: "開発部",
  joined_on: "2026-04-01",
  classroom_id: CLS_A,
  classroom_name: "Aクラス",
  teacher_id: T1,
  teacher_name: "田中 祥司",
  training_starts_on: "2026-04-01",
  training_due_on: "2026-09-30",
  active: true,
  row_version: 2,
  progress_percent: 58,
  invitation_state: "sent",
  ...over,
});

describe("講師管理（WEB-03）", () => {
  it("講師ロールは閲覧のみ（登録・停止の操作を表示しない）", async () => {
    mockApi("teacher", { "GET /teachers": () => ({ body: page([teacher()]) }), "GET /classrooms": () => ({ body: page([classroom()]) }) });
    renderPage(<TeachersPage />, { path: "/teachers", url: "/teachers" });
    expect(await screen.findByText("田中 祥司")).toBeInTheDocument();
    expect(screen.getByText(/講師アカウントでは閲覧のみできます/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /講師を登録/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "田中 祥司さんの詳細" })).toHaveAttribute("href", `/teachers/${T1}`);
  });

  it("状態・検索の絞り込みをURLとAPIに反映する", async () => {
    const calls = mockApi("admin", { "GET /teachers": () => ({ body: page([teacher()]) }), "GET /classrooms": () => ({ body: page([]) }), "GET /settings": () => ({ status: 500, body: { code: "INTERNAL" } }) });
    const { router } = renderPage(<TeachersPage />, { path: "/teachers", url: "/teachers?q=%E7%94%B0%E4%B8%AD&status=inactive" });
    await screen.findByText("田中 祥司");
    const list = calls.filter((c) => c.path === "/teachers");
    expect(list[0]?.query.get("q")).toBe("田中");
    expect(list[0]?.query.get("status")).toBe("inactive");
    await userEvent.setup().selectOptions(screen.getByLabelText("状態"), "all");
    await waitFor(() => expect(router.state.location.search).toContain("status=all"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/teachers").at(-1)?.query.has("status")).toBe(false));
  });

  it("停止は対象を確認し、409の理由（主担当のクラス）を日本語で表示する", async () => {
    const calls = mockApi("admin", {
      "GET /teachers": () => ({ body: page([teacher()]) }),
      "GET /classrooms": () => ({ body: page([]) }),
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
      [`DELETE /teachers/${T1}`]: () => ({
        status: 409,
        body: { code: "TEACHER_IS_PRIMARY", message_ja: "主担当のクラスがあるため停止できません。先にクラスの主担当講師を変更してください。", request_id: "req-1", details: { classrooms: [{ id: CLS_A, name: "Aクラス" }] } },
      }),
    });
    const user = userEvent.setup();
    renderPage(<TeachersPage />, { path: "/teachers", url: "/teachers" });
    await user.click(await screen.findByRole("button", { name: "田中 祥司さんを停止" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("田中 祥司（T001）");
    await user.click(within(dialog).getByRole("button", { name: "停止する" }));
    expect(await within(dialog).findByText(/主担当のクラスがあるため停止できません/)).toBeInTheDocument();
    expect(within(dialog).getByText("主担当のクラス: Aクラス")).toBeInTheDocument();
    expect(within(dialog).getByText(/req-1/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "DELETE")?.headers["If-Match"]).toBe('"3"');
  });
});

describe("講師の編集（WEB-04）", () => {
  it("If-Matchで保存し、更新競合では再読み込みを案内する", async () => {
    let version = 3;
    const calls = mockApi("admin", {
      [`GET /teachers/${T1}`]: () => ({ body: { data: teacher({ row_version: version, kana: version > 3 ? "たなか（更新）" : "たなか しょうじ" }), checked_at: CHECKED_AT } }),
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
      [`PATCH /teachers/${T1}`]: () => {
        version = 4;
        return { status: 409, body: { code: "VERSION_CONFLICT", message_ja: "情報が更新されました。再読み込みしてください。", request_id: "r" } };
      },
    });
    const user = userEvent.setup();
    renderPage(<TeacherFormPage />, { path: "/teachers/:id", url: `/teachers/${T1}` });
    const name = await screen.findByLabelText(/氏名/);
    expect(screen.getByLabelText(/メールアドレス/)).toHaveAttribute("readonly");
    await user.clear(name);
    await user.type(name, "田中 祥司（変更）");
    await user.click(screen.getByRole("button", { name: "変更を保存" }));
    expect(await screen.findByText(/情報が更新されました。再読み込みしてください。/)).toBeInTheDocument();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers["If-Match"]).toBe('"3"');
    expect(patch?.body).toMatchObject({ display_name: "田中 祥司（変更）", email: "tanaka@example.invalid", specialties: ["IT基礎"] });
    await user.click(screen.getByRole("button", { name: "最新の情報を読み込む" }));
    await waitFor(() => expect(screen.getByLabelText(/ふりがな/)).toHaveValue("たなか（更新）"));
  });

  it("必須項目が空なら送信せず日本語のエラーを表示する", async () => {
    const calls = mockApi("admin", { "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }) });
    const user = userEvent.setup();
    renderPage(<TeacherFormPage />, { path: "/teachers/new", url: "/teachers/new" });
    await user.click(await screen.findByRole("button", { name: "登録して招待" }));
    expect(await screen.findAllByText("必須項目です。")).toHaveLength(4);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("登録後はメール重複をメールアドレス欄に表示する", async () => {
    mockApi("admin", {
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
      "POST /teachers": () => ({ status: 409, body: { code: "EMAIL_TAKEN", message_ja: "このメールアドレスは既に登録されています。", request_id: "r", field_errors: { email: "このメールアドレスは既に登録されています。" } } }),
    });
    const user = userEvent.setup();
    renderPage(<TeacherFormPage />, { path: "/teachers/new", url: "/teachers/new" });
    await user.type(await screen.findByLabelText(/講師番号/), "T009");
    await user.type(screen.getByLabelText(/^氏名/), "佐藤 直子");
    await user.type(screen.getByLabelText(/メールアドレス/), "sato@example.invalid");
    await user.type(screen.getByLabelText(/所属部署/), "人事部");
    await user.click(screen.getByRole("button", { name: "登録して招待" }));
    const email = screen.getByLabelText(/メールアドレス/);
    await waitFor(() => expect(email).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("このメールアドレスは既に登録されています。")).toBeInTheDocument();
    expect(screen.getByText(/赤字の項目を確認してください/)).toBeInTheDocument();
  });
});

describe("新入社員（WEB-05/06）", () => {
  it("クラスを選ぶとそのクラスの講師だけを候補にし、クラス変更で講師をリセットする", async () => {
    const calls = mockApi("admin", {
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
      "GET /classrooms": () => ({ body: page([classroom(), classroom({ id: CLS_B, name: "Bクラス", student_count: 30, capacity: 30 }), classroom({ id: "66666666-6666-4666-8666-666666666666", name: "Cクラス", starts_on: "2026-11-01", ends_on: "2027-01-31" })]) }),
      [`GET /classrooms/${CLS_A}/teachers`]: () => ({ body: page([teacher(), teacher({ id: T2, display_name: "小山 祐介", classrooms: [{ id: CLS_A, name: "Aクラス", is_primary: false }] })]) }),
      "GET /classrooms/66666666-6666-4666-8666-666666666666/teachers": () => ({ body: page([teacher({ id: T2, display_name: "小山 祐介" })]) }),
    });
    const user = userEvent.setup();
    renderPage(<StudentFormPage />, { path: "/students/new", url: "/students/new" });
    const cls = await screen.findByLabelText(/所属クラス/);
    await waitFor(() => expect(within(cls).getByRole("option", { name: /Bクラス（30 \/ 30名） 満席/ })).toBeDisabled());
    const teacherSelect = screen.getByLabelText(/担当講師/);
    expect(teacherSelect).toBeDisabled();
    await user.selectOptions(cls, CLS_A);
    await waitFor(() => expect(within(teacherSelect).getByRole("option", { name: "田中 祥司（主担当）" })).toBeInTheDocument());
    expect(screen.getByLabelText(/研修開始日/)).toHaveValue("2026-10-01");
    expect(screen.getByLabelText(/終了予定日/)).toHaveValue("2026-12-31");
    await user.selectOptions(teacherSelect, T2);
    expect(teacherSelect).toHaveValue(T2);
    await user.selectOptions(cls, "66666666-6666-4666-8666-666666666666");
    expect(teacherSelect).toHaveValue("");
    await waitFor(() => expect(within(teacherSelect).queryByRole("option", { name: /田中 祥司/ })).not.toBeInTheDocument());
    expect(calls.some((c) => c.path === "/classrooms/66666666-6666-4666-8666-666666666666/teachers")).toBe(true);
  });

  it("トップバー検索の q を検索欄とAPIに反映し、期限超過を文字で示す", async () => {
    const calls = mockApi("admin", {
      "GET /students": () => ({ body: page([student()]) }),
      "GET /classrooms": () => ({ body: page([classroom()]) }),
      "GET /teachers": () => ({ body: page([teacher()]) }),
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
    });
    renderPage(<StudentsPage />, { path: "/students", url: "/students?q=%E5%92%8C%E7%94%B0" });
    expect(await screen.findByText("和田 一夫")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "検索" })).toHaveValue("和田");
    expect(calls.find((c) => c.path === "/students")?.query.get("q")).toBe("和田");
    expect(screen.getByText("期限超過")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "和田 一夫の進捗" })).toHaveAttribute("aria-valuenow", "58");
  });
});

describe("ダッシュボード（WEB-02）", () => {
  it("APIの日時からJSTの日付を表示し、平均進捗なしは「未設定」", async () => {
    const dashboard: Dashboard = {
      student_count: 128,
      average_progress_percent: null,
      pending_reservation_count: 1,
      today_lesson_count: 1,
      progress_trend: [
        { month: "2026-09", percent: null },
        { month: "2026-10", percent: null },
      ],
      today_lessons: [
        {
          id: "s1",
          classroom_id: CLS_A,
          teacher_id: T1,
          unit_id: null,
          title: "ビジネスマナー",
          starts_at: "2026-10-02T01:00:00.000Z",
          ends_at: "2026-10-02T02:30:00.000Z",
          capacity: 10,
          booking_closes_at: "2026-10-02T00:00:00.000Z",
          meeting_url: null,
          has_meeting_url: false,
          cancel_before_seconds: 86400,
          teacher_name: "別府 悦子",
          classroom_name: "Aクラス",
          remaining: 8,
          pending_count: 0,
          approved_count: 2,
          state: "open",
          row_version: 1,
        },
      ],
      pending_reservations: [
        {
          id: "r1",
          slot_id: "s2",
          student_id: "st1",
          status: "pending",
          starts_at: "2026-10-05T05:00:00.000Z",
          ends_at: "2026-10-05T06:30:00.000Z",
          expires_at: "2026-10-03T05:00:00.000Z",
          row_version: 1,
          reason: null,
          student_name: "和田 一夫",
          slot_title: "IT基礎",
          checked_at: CHECKED_AT,
        },
      ],
    };
    mockApi("admin", {
      "GET /dashboard": () => ({ body: { data: dashboard, checked_at: "2026-10-01T15:30:00.000Z" } }),
      "GET /students": () => ({ body: page([]) }),
      "GET /classrooms": () => ({ body: page([classroom()]) }),
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
    });
    renderPage(<DashboardPage />, { path: "/dashboard", url: "/dashboard" });
    // 2026-10-01T15:30Z is already 10月2日 00:30 in Asia/Tokyo.
    expect(await screen.findByText("2026年10月2日（金）")).toBeInTheDocument();
    expect(screen.getByText("未設定")).toBeInTheDocument();
    expect(screen.getByText("ビジネスマナー")).toBeInTheDocument();
    expect(screen.getByText("承認済み 2名")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "和田 一夫さんの予約申請を確認" })).toHaveAttribute("href", "/bookings/reservations/r1");
    expect(screen.getByText("進捗データがまだありません")).toBeInTheDocument();
    expect(screen.getByText(/最終取得 10月2日（金）00:30/)).toBeInTheDocument();
  });

  it("読み込み失敗は問い合わせ番号と再試行を表示する", async () => {
    let fail = true;
    mockApi("admin", {
      "GET /dashboard": () =>
        fail
          ? { status: 503, body: { code: "DB_UNAVAILABLE", message_ja: "データベースに接続できません。変更は保存されていません。", request_id: "req-503" } }
          : { body: { data: { student_count: 3, average_progress_percent: 50, pending_reservation_count: 0, today_lesson_count: 0, progress_trend: [], today_lessons: [], pending_reservations: [] }, checked_at: CHECKED_AT } },
      "GET /students": () => ({ body: page([]) }),
      "GET /classrooms": () => ({ body: page([]) }),
      "GET /settings": () => ({ status: 403, body: { code: "FORBIDDEN" } }),
    });
    const user = userEvent.setup();
    renderPage(<DashboardPage />, { path: "/dashboard", url: "/dashboard" });
    expect(await screen.findByText("問い合わせ番号: req-503")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("在籍受講者")).toBeInTheDocument();
  });
});

describe("設定（WEB-16/18/19）", () => {
  it("講師は個人設定タブだけを使える", async () => {
    mockApi("teacher", {
      "GET /me": () => ({
        body: {
          data: {
            id: "x",
            display_name: "田中 祥司",
            email: "teacher@example.invalid",
            role: "teacher",
            active: true,
            organization: { id: "o", name: "H&A研修センター", timezone: "Asia/Tokyo" },
            preferences: { theme: "system", notifications_enabled: true, row_version: 0 },
            student: null,
            mfa: { required: false, verified: false },
          },
          checked_at: CHECKED_AT,
        },
      }),
    });
    const { router } = renderPage(<SettingsPage />, { path: "/settings/:tab?", url: "/settings/users" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/personal"));
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["個人設定"]);
    expect(await screen.findByRole("radio", { name: "ダーク" })).toBeInTheDocument();
  });

  it("管理者のタブはURLで切り替わる", async () => {
    mockApi("admin", {
      "GET /settings/users": () => ({ body: page([]) }),
      "GET /settings/account-deletion-requests": () => ({ body: page([]) }),
    });
    const user = userEvent.setup();
    const { router } = renderPage(<SettingsPage />, { path: "/settings/:tab?", url: "/settings/users" });
    expect(await screen.findByRole("heading", { level: 1, name: "ユーザー管理" })).toBeInTheDocument();
    expect((await screen.findAllByRole("tab")).map((t) => t.textContent)).toEqual(["システム設定", "データ移植", "ユーザー管理", "ログ・イベント", "個人設定"]);
    expect(await screen.findByText("削除の申請はありません")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "ログ・イベント" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/events"));
  });
});

describe("クラス設定（WEB-08）", () => {
  it("教育プログラムは公開中のバージョンだけを候補にする", async () => {
    const PV1 = "77777777-7777-4777-8777-777777777777";
    const PV2 = "88888888-8888-4888-8888-888888888888";
    const program = (id: string, name: string, published: string, latest: { id: string; version_number: number; state: "draft" | "published" | "archived" }) => ({
      id,
      name,
      description: "",
      department_name: "",
      archived: false,
      published_version_id: published,
      unit_count: 1,
      material_count: 0,
      student_count: 0,
      row_version: 1,
      latest_version: latest,
      draft_version_id: latest.state === "draft" ? latest.id : null,
      created_at: CHECKED_AT,
    });
    const calls = mockApi("admin", {
      "GET /teachers": () => ({ body: page([teacher()]) }),
      "GET /programs": () => ({
        body: page([
          program("p1", "基礎研修", PV1, { id: PV1, version_number: 2, state: "published" }),
          program("p2", "ビジネスマナー", PV2, { id: "99999999-9999-4999-8999-999999999999", version_number: 4, state: "draft" }),
        ]),
      }),
      [`GET /program-versions/${PV2}`]: () => ({
        body: {
          data: {
            id: PV2,
            program_id: "p2",
            version_number: 3,
            state: "published",
            row_version: 1,
            policy: { max_quiz_attempts: 3, quiz_score_policy: "highest" },
            published_at: CHECKED_AT,
            created_at: CHECKED_AT,
            source_version_id: null,
            unit_count: 1,
            material_count: 0,
            required_weight_total: 1,
          },
          checked_at: CHECKED_AT,
        },
      }),
    });
    renderPage(<ClassroomDetailPage />, { path: "/classrooms/new", url: "/classrooms/new" });
    const group = await screen.findByRole("group", { name: /教育プログラム/ });
    expect(await within(group).findByRole("checkbox", { name: /^基礎研修 v2/ })).toBeInTheDocument();
    expect(await within(group).findByRole("checkbox", { name: /^ビジネスマナー v3/ })).toBeInTheDocument();
    expect(within(group).queryByRole("checkbox", { name: /v4/ })).not.toBeInTheDocument();
    expect(calls.find((c) => c.path === "/programs")?.query.get("status")).toBe("published");
    expect(calls.some((c) => c.path === `/program-versions/${PV1}`)).toBe(false);
  });
});
