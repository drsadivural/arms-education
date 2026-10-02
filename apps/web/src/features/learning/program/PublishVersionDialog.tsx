import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QUIZ_SCORE_POLICY_LABELS } from "@arms/contracts";
import { ConfirmDialog } from "../../../components/ui/Dialog";
import { useToast } from "../../../components/ui/Toast";
import { api } from "../../../lib/api";
import { learningKeys, type ActionResult, type ProgramVersion } from "../api";
import { versionLabel } from "../format";
import { PublishProblems } from "../PublishProblems";

/**
 * 確認して公開: lists what becomes fixed, then POST /program-versions/{id}/publish. API blockers (SCAN_PENDING,
 * SCANNER_UNAVAILABLE, VERSION_NOT_PUBLISHABLE with each problem…) are shown in Japanese and the dialog stays open.
 */
export function PublishVersionDialog({
  open,
  onOpenChange,
  version,
  published,
  programId,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  version: ProgramVersion;
  published: ProgramVersion | null;
  programId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const publish = async () => {
    setPending(true);
    setError(null);
    try {
      await api.post<ActionResult>(`/program-versions/${version.id}/publish`);
      toast.success(`${versionLabel(version.version_number)} を公開しました`, published ? `${versionLabel(published.version_number)} は公開終了になりました。受講中の新入社員は割り当て済みのバージョンで学習を続けます。` : undefined);
      onOpenChange(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: learningKeys.versions(programId) }),
        qc.invalidateQueries({ queryKey: learningKeys.program(programId) }),
        qc.invalidateQueries({ queryKey: ["learning", "programs"] }),
        qc.invalidateQueries({ queryKey: ["learning", "units"] }),
        qc.invalidateQueries({ queryKey: ["learning", "materials"] }),
      ]);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        if (!o) setError(null);
        onOpenChange(o);
      }}
      tone="primary"
      title={`下書き ${versionLabel(version.version_number)} を公開しますか？`}
      description={
        <div className="flex flex-col gap-2">
          <p>公開すると、次の内容がこのバージョンに固定され、以後は変更できません。</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              単元 {version.unit_count}件・教材 {version.material_count}件（すべての教材が公開されます）
            </li>
            <li>必須単元の重みの合計 {version.required_weight_total}</li>
            <li>
              確認テストの受験回数上限 {version.policy.max_quiz_attempts}回・{QUIZ_SCORE_POLICY_LABELS[version.policy.quiz_score_policy]}
            </li>
          </ul>
          <p className="text-xs text-muted">
            {published
              ? `現在公開中の ${versionLabel(published.version_number)} は「公開終了」になります。${versionLabel(published.version_number)} を割り当て済みの新入社員の進捗・成績はそのまま保持され、新しく割り当てる受講者から ${versionLabel(version.version_number)} が適用されます。`
              : "公開後に新入社員またはクラスへ受講を割り当てられます。"}
          </p>
        </div>
      }
      confirmLabel="公開する"
      loading={pending}
      onConfirm={publish}
    >
      <PublishProblems error={error} />
    </ConfirmDialog>
  );
}
