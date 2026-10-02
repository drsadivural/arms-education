import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { EmptyState, ErrorState, InlineError, LastFetched, LoadingRows } from "../../../components/ui/Feedback";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, NetworkError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { getMaterials, getUnits, learningKeys, type DataResponse, type Material, type ProgramVersion, type Unit } from "../api";
import { completionConditionLabel, materialKindsSummary, versionLabel } from "../format";
import { MaterialsPanel } from "./MaterialsPanel";
import { UnitFormDialog, unitBody } from "./UnitFormDialog";

const MAX_POSITION = 10000;

/**
 * Swaps the order of two units. Positions are unique per version, so the first unit is parked on a free position,
 * then both are moved (three PATCHes with If-Match).
 */
export async function swapUnitPositions(a: Unit, b: Unit, all: Unit[]): Promise<void> {
  const free = Math.max(...all.map((u) => u.position)) + 1;
  if (free > MAX_POSITION) throw new Error("順序の番号が上限に達しているため並べ替えできません。単元を編集して順序を振り直してください。");
  const parked = await api.patch<DataResponse<Unit>>(`/units/${a.id}`, unitBody({ ...a, position: free }), { ifMatch: a.row_version });
  await api.patch<DataResponse<Unit>>(`/units/${b.id}`, unitBody({ ...b, position: a.position }), { ifMatch: b.row_version });
  await api.patch<DataResponse<Unit>>(`/units/${a.id}`, unitBody({ ...a, position: b.position }), { ifMatch: parked.data.row_version });
}

/** 単元と教材 (WEB-10): units of the selected version with materials summary, completion conditions and weights. */
export function UnitsPanel({
  version,
  canEditUnits,
  canEditMaterials,
  selectedUnitId,
  onSelectUnit,
}: {
  version: ProgramVersion;
  canEditUnits: boolean;
  canEditMaterials: boolean;
  selectedUnitId: string | null;
  onSelectUnit(id: string | null): void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const isDraft = version.state === "draft";
  const units = useQuery({ queryKey: learningKeys.units(version.id), queryFn: () => getUnits(version.id) });
  const list = units.data?.items;
  const materials = useQueries({
    queries: (list ?? []).map((u) => ({
      queryKey: learningKeys.materials(u.id),
      queryFn: () => getMaterials(u.id),
      // Pending scan verdicts update in the background (draft materials follow the upload verdict).
      refetchInterval: (q: { state: { data?: { items: Material[] } } }) => (q.state.data?.items.some((m) => m.scan_state === "pending") ? 15_000 : false),
    })),
  });
  const [dialog, setDialog] = useState<{ unit: Unit | null } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);

  const lockedReason = !isDraft
    ? `${versionLabel(version.version_number)} は${version.state === "published" ? "公開中" : "公開終了"}のため、単元と教材は変更できません。新しいバージョン（下書き）で変更してください。`
    : null;

  const move = async (index: number, delta: number) => {
    if (!list) return;
    const a = list[index];
    const b = list[index + delta];
    if (!a || !b) return;
    setMoving(a.id);
    setMoveError(null);
    try {
      await swapUnitPositions(a, b, list);
      toast.success("単元の順序を変更しました", `「${a.title}」と「${b.title}」を入れ替えました。`);
    } catch (e) {
      setMoveError(e);
    } finally {
      setMoving(null);
      await qc.invalidateQueries({ queryKey: learningKeys.units(version.id) });
    }
  };

  const nextPosition = list && list.length ? Math.min(MAX_POSITION, Math.max(...list.map((u) => u.position)) + 1) : 1;
  const selected = list?.find((u) => u.id === selectedUnitId) ?? null;
  const selectedIndex = list && selected ? list.indexOf(selected) : -1;

  return (
    <>
      <Card aria-labelledby="units-heading">
        <CardHeader
          id="units-heading"
          title="単元と教材"
          description={lockedReason ?? `下書き ${versionLabel(version.version_number)} を編集しています。順序・必須・重み・合格点・出席・講師承認を設定できます。`}
          actions={
            canEditUnits && isDraft ? (
              <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} disabled={!online || !list} onClick={() => setDialog({ unit: null })}>
                単元を追加
              </Button>
            ) : null
          }
        />
        {units.isLoading ? (
          <LoadingRows rows={3} label="単元を読み込み中です" />
        ) : units.error ? (
          <ErrorState error={units.error} onRetry={() => void units.refetch()} />
        ) : list && list.length === 0 ? (
          <EmptyState
            title="単元がありません"
            description={canEditUnits && isDraft ? "「単元を追加」から最初の単元を登録してください。単元がないバージョンは公開できません。" : "このバージョンには単元が登録されていません。"}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <caption className="sr-only">{`${versionLabel(version.version_number)}の単元一覧`}</caption>
              <thead>
                <tr className="bg-surface-2 text-left text-xs text-muted">
                  <th scope="col" className="px-3 py-3 font-medium">順序</th>
                  <th scope="col" className="px-3 py-3 font-medium">単元</th>
                  <th scope="col" className="px-3 py-3 font-medium">教材</th>
                  <th scope="col" className="px-3 py-3 font-medium">完了条件</th>
                  <th scope="col" className="px-3 py-3 font-medium">重み</th>
                  <th scope="col" className="px-3 py-3 font-medium">区分</th>
                  <th scope="col" className="px-3 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {list?.map((u, i) => {
                  const mats = materials[i]?.data?.items;
                  const isSelected = u.id === selectedUnitId;
                  return (
                    <tr key={u.id} className={isSelected ? "border-b border-line bg-primary-soft/50" : "border-b border-line"} aria-current={isSelected ? "true" : undefined}>
                      <td className="px-3 py-3 tabular-nums">{String(u.position).padStart(2, "0")}</td>
                      <td className="px-3 py-3 font-medium">{u.title}</td>
                      <td className="px-3 py-3 text-xs">{mats ? `${materialKindsSummary(mats)}（${mats.length}件）` : `${u.material_count}件`}</td>
                      <td className="px-3 py-3 text-xs">{mats ? completionConditionLabel(u, mats) : "—"}</td>
                      <td className="px-3 py-3 tabular-nums">{u.weight}</td>
                      <td className="px-3 py-3">
                        <Badge tone={u.required ? "warning" : "neutral"}>{u.required ? "必須" : "任意"}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="relative flex flex-wrap items-center gap-1">
                          <Button variant={isSelected ? "primary" : "secondary"} size="sm" onClick={() => onSelectUnit(isSelected ? null : u.id)} aria-pressed={isSelected} aria-label={`「${u.title}」の教材を${isSelected ? "閉じる" : "表示"}`}>
                            教材
                          </Button>
                          {canEditUnits && isDraft ? (
                            <>
                              <Button variant="ghost" size="sm" disabled={!online} onClick={() => setDialog({ unit: u })} aria-label={`「${u.title}」を編集`}>
                                編集
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`「${u.title}」を上へ移動`}
                                disabled={!online || i === 0 || !!moving}
                                loading={moving === u.id}
                                onClick={() => move(i, -1)}
                                icon={<ArrowUp className="size-4" aria-hidden />}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`「${u.title}」を下へ移動`}
                                disabled={!online || i === (list?.length ?? 0) - 1 || !!moving}
                                onClick={() => move(i, 1)}
                                icon={<ArrowDown className="size-4" aria-hidden />}
                              />
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {moveError ? (
          <div className="mt-3">
            {moveError instanceof ApiError || moveError instanceof NetworkError ? (
              <InlineError error={moveError} />
            ) : (
              <p role="alert" className="text-xs font-medium text-danger">
                {moveError instanceof Error ? moveError.message : "並べ替えを完了できませんでした。"}
              </p>
            )}
            <p className="mt-1 text-xs text-muted">最新の順序を再読み込みしました。必要に応じてもう一度操作してください。</p>
          </div>
        ) : null}
        <LastFetched checkedAt={units.data?.checked_at} className="mt-3" />
      </Card>
      {selected ? (
        <MaterialsPanel
          unit={selected}
          materials={materials[selectedIndex]?.data?.items}
          checkedAt={materials[selectedIndex]?.data?.checked_at ?? null}
          isLoading={!!materials[selectedIndex]?.isLoading}
          error={materials[selectedIndex]?.error}
          onRetry={() => void materials[selectedIndex]?.refetch()}
          editable={isDraft && canEditMaterials}
          lockedReason={lockedReason ?? (canEditMaterials ? null : "教材の編集は、管理者またはこのプログラムを使うクラスの担当講師が行えます。")}
        />
      ) : list && list.length > 0 ? (
        <p className="mt-3 text-xs text-muted">単元の「教材」を押すと、教材の一覧・追加・プレビューを表示します。</p>
      ) : null}
      {dialog ? (
        <UnitFormDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          versionId={version.id}
          unit={dialog.unit}
          nextPosition={nextPosition}
          onSaved={(u, created) => {
            void qc.invalidateQueries({ queryKey: learningKeys.units(version.id) });
            void qc.invalidateQueries({ queryKey: ["learning", "versions"] });
            toast.success(created ? "単元を追加しました" : "単元を保存しました", `「${u.title}」`);
            if (created) onSelectUnit(u.id);
          }}
        />
      ) : null}
    </>
  );
}
