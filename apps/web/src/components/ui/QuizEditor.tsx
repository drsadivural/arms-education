import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { Field, Input, Textarea } from "./Field";

export interface QuizChoiceDraft {
  id: string;
  label: string;
}

export interface QuizQuestionDraft {
  /** Stable React key (not sent to the API). */
  key: string;
  prompt: string;
  choices: QuizChoiceDraft[];
  correct_option_ids: string[];
  points: number;
}

export interface QuizDraft {
  title: string;
  questions: QuizQuestionDraft[];
}

let seq = 0;
const newKey = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Next free choice id within a question (c1, c2, …). Ids only need to be unique per question. */
export function nextChoiceId(choices: QuizChoiceDraft[]): string {
  let n = choices.length + 1;
  const used = new Set(choices.map((c) => c.id));
  while (used.has(`c${n}`)) n++;
  return `c${n}`;
}

export function emptyQuestion(): QuizQuestionDraft {
  return {
    key: newKey(),
    prompt: "",
    choices: [
      { id: "c1", label: "" },
      { id: "c2", label: "" },
    ],
    correct_option_ids: [],
    points: 10,
  };
}

/** Draft → QuizDefinitionInput body (keys dropped, labels/prompts trimmed by the schema). */
export function toQuizDefinitionInput(draft: QuizDraft) {
  return {
    title: draft.title,
    questions: draft.questions.map((q) => ({ prompt: q.prompt, choices: q.choices.map((c) => ({ id: c.id, label: c.label })), correct_option_ids: q.correct_option_ids, points: q.points })),
  };
}

export function fromQuizDefinition(def: { title: string; questions: { prompt: string; choices: QuizChoiceDraft[]; correct_option_ids: string[]; points: number }[] }): QuizDraft {
  return {
    title: def.title,
    questions: def.questions.map((q) => ({ key: newKey(), prompt: q.prompt, choices: q.choices.map((c) => ({ ...c })), correct_option_ids: [...q.correct_option_ids], points: q.points })),
  };
}

const MAX_CHOICES = 10;
const MAX_QUESTIONS = 100;

/**
 * Editor for a 確認テスト definition: questions, choices, correct answers (one or more) and points. Controlled;
 * `errors` uses the API/Zod paths ("questions.0.prompt", "questions.1.correct_option_ids", …).
 */
export function QuizEditor({
  value,
  onChange,
  errors = {},
  disabled,
}: {
  value: QuizDraft;
  onChange(next: QuizDraft): void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const setQuestion = (index: number, patch: Partial<QuizQuestionDraft>) =>
    onChange({ ...value, questions: value.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)) });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.questions.length) return;
    const next = [...value.questions];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ ...value, questions: next });
  };
  const total = value.questions.reduce((s, q) => s + (Number.isFinite(q.points) ? q.points : 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <Field label="テストの名称" required error={errors.title}>
        {(p) => <Input {...p} value={value.title} disabled={disabled} maxLength={200} onChange={(e) => onChange({ ...value, title: e.target.value })} />}
      </Field>
      <p className="text-xs text-muted" aria-live="polite">
        {value.questions.length}問・合計{total}点
      </p>
      {errors.questions ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.questions}
        </p>
      ) : null}
      <ol className="flex flex-col gap-4">
        {value.questions.map((q, qi) => {
          const prefix = `questions.${qi}`;
          const qNo = qi + 1;
          return (
            <li key={q.key} className="rounded-[var(--radius-control)] border border-line p-4">
              <fieldset disabled={disabled} className="flex flex-col gap-3">
                <legend className="sr-only">問{qNo}</legend>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">問{qNo}</h3>
                  <div className="flex gap-1">
                  <Button variant="ghost" size="sm" aria-label={`問${qNo}を上へ移動`} disabled={qi === 0} onClick={() => move(qi, -1)} icon={<ArrowUp className="size-4" aria-hidden />} />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`問${qNo}を下へ移動`}
                    disabled={qi === value.questions.length - 1}
                    onClick={() => move(qi, 1)}
                    icon={<ArrowDown className="size-4" aria-hidden />}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`問${qNo}を削除`}
                    disabled={value.questions.length <= 1}
                    onClick={() => onChange({ ...value, questions: value.questions.filter((_, i) => i !== qi) })}
                    icon={<Trash2 className="size-4" aria-hidden />}
                  />
                  </div>
                </div>
                <Field label={`問${qNo}の問題文`} required error={errors[`${prefix}.prompt`]}>
                  {(p) => <Textarea {...p} value={q.prompt} maxLength={2000} className="min-h-16" onChange={(e) => setQuestion(qi, { prompt: e.target.value })} />}
                </Field>
                <div role="group" aria-label={`問${qNo}の選択肢（正答にチェック）`} className="flex flex-col gap-2">
                  <p className="text-xs font-bold">
                    選択肢<span className="ml-2 font-normal text-muted">正答にチェックを付けてください（複数可）</span>
                  </p>
                  {q.choices.map((c, ci) => {
                    const correct = q.correct_option_ids.includes(c.id);
                    return (
                      <div key={c.id} className="flex items-center gap-2">
                        <label className="inline-flex min-h-10 shrink-0 items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--arms-primary)]"
                            checked={correct}
                            aria-label={`問${qNo} 選択肢${ci + 1}を正答にする`}
                            onChange={(e) =>
                              setQuestion(qi, {
                                correct_option_ids: e.target.checked ? [...q.correct_option_ids, c.id] : q.correct_option_ids.filter((id) => id !== c.id),
                              })
                            }
                          />
                          <span className={correct ? "font-bold text-success" : "text-muted"}>{correct ? "正答" : "誤答"}</span>
                        </label>
                        <Input
                          aria-label={`問${qNo} 選択肢${ci + 1}`}
                          value={c.label}
                          maxLength={500}
                          aria-invalid={!!errors[`${prefix}.choices.${ci}.label`]}
                          onChange={(e) => setQuestion(qi, { choices: q.choices.map((x, i) => (i === ci ? { ...x, label: e.target.value } : x)) })}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`問${qNo} 選択肢${ci + 1}を削除`}
                          disabled={q.choices.length <= 2}
                          onClick={() =>
                            setQuestion(qi, { choices: q.choices.filter((x) => x.id !== c.id), correct_option_ids: q.correct_option_ids.filter((id) => id !== c.id) })
                          }
                          icon={<Trash2 className="size-4" aria-hidden />}
                        />
                      </div>
                    );
                  })}
                  {[`${prefix}.choices`, `${prefix}.correct_option_ids`, ...q.choices.map((_, ci) => `${prefix}.choices.${ci}.label`)]
                    .map((k) => errors[k])
                    .filter(Boolean)
                    .slice(0, 1)
                    .map((msg) => (
                      <p key="err" role="alert" className="text-xs font-medium text-danger">
                        {msg}
                      </p>
                    ))}
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={q.choices.length >= MAX_CHOICES}
                      icon={<Plus className="size-3.5" aria-hidden />}
                      onClick={() => setQuestion(qi, { choices: [...q.choices, { id: nextChoiceId(q.choices), label: "" }] })}
                    >
                      選択肢を追加
                    </Button>
                  </div>
                </div>
                <Field label={`問${qNo}の配点`} required error={errors[`${prefix}.points`]} className="max-w-40">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      inputMode="decimal"
                      min={1}
                      max={1000}
                      value={Number.isFinite(q.points) ? q.points : ""}
                      onChange={(e) => setQuestion(qi, { points: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                    />
                  )}
                </Field>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          variant="secondary"
          disabled={disabled || value.questions.length >= MAX_QUESTIONS}
          icon={<Plus className="size-4" aria-hidden />}
          onClick={() => onChange({ ...value, questions: [...value.questions, emptyQuestion()] })}
        >
          問題を追加
        </Button>
      </div>
    </div>
  );
}
