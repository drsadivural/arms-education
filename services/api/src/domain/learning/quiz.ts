/**
 * Server-side quiz scoring (docs/04: テスト採点はサーバー、正答を受講者APIで返さない).
 * A question is correct only when the selected option set equals the answer key exactly; unanswered questions
 * score 0. score = earned points / total points × 100, rounded to 2 decimals.
 */
import { ApiError } from "../../http/errors";

export interface QuizQuestionRow {
  id: string;
  prompt: string;
  choices: { id: string; label: string }[];
  answer_key: string[];
  points: number;
}

export interface QuizAnswer {
  question_id: string;
  selected_option_ids: string[];
}

export interface QuizScore {
  earned: number;
  total: number;
  correct: number;
  questionCount: number;
  score: number;
}

export function scoreQuiz(questions: QuizQuestionRow[], answers: QuizAnswer[]): QuizScore {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const fieldErrors: Record<string, string> = {};
  const seen = new Set<string>();
  answers.forEach((a, i) => {
    const q = byId.get(a.question_id.toLowerCase());
    if (!q) {
      fieldErrors[`answers.${i}.question_id`] = "このテストの問題ではありません。";
      return;
    }
    if (seen.has(q.id)) fieldErrors[`answers.${i}.question_id`] = "同じ問題への回答が重複しています。";
    seen.add(q.id);
    const valid = new Set(q.choices.map((c) => c.id));
    if (a.selected_option_ids.some((o) => !valid.has(o))) fieldErrors[`answers.${i}.selected_option_ids`] = "選択肢から選んでください。";
    if (new Set(a.selected_option_ids).size !== a.selected_option_ids.length) fieldErrors[`answers.${i}.selected_option_ids`] = "同じ選択肢が重複しています。";
  });
  if (Object.keys(fieldErrors).length) throw new ApiError("VALIDATION_FAILED", { field_errors: fieldErrors });

  const selected = new Map(answers.map((a) => [a.question_id.toLowerCase(), new Set(a.selected_option_ids)]));
  let earned = 0;
  let total = 0;
  let correct = 0;
  for (const q of questions) {
    total += q.points;
    const sel = selected.get(q.id);
    const key = new Set(q.answer_key);
    if (sel && sel.size === key.size && [...key].every((k) => sel.has(k))) {
      earned += q.points;
      correct++;
    }
  }
  const score = total > 0 ? Math.round((earned / total) * 10000) / 100 : 0;
  return { earned, total, correct, questionCount: questions.length, score };
}
