import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import { getProgram, getVersions, learningKeys, useClassroomsLookup, type Program, type ProgramVersion } from "../../features/learning/api";
import { versionLabel } from "../../features/learning/format";
import { EnrollmentPanel } from "../../features/learning/program/EnrollmentPanel";
import { ProgramInfoForm } from "../../features/learning/program/ProgramInfoForm";
import { PublishVersionDialog } from "../../features/learning/program/PublishVersionDialog";
import { UnitsPanel } from "../../features/learning/program/UnitsPanel";
import { VersionNotice, VersionPanel, versionOptionLabel } from "../../features/learning/program/VersionPanel";
import { useUrlParams } from "../../features/learning/useUrlParams";

const TITLE = "教育プログラム・教材を編集";
const CRUMBS = [{ label: "教育プログラム管理", to: "/programs" }];
const URL_KEYS = ["version", "unit"] as const;

/** Default version to show: the draft being edited, else the published one, else the newest. */
export function defaultVersion(versions: ProgramVersion[]): ProgramVersion | null {
  return versions.find((v) => v.state === "draft") ?? versions.find((v) => v.state === "published") ?? versions[0] ?? null;
}

/** Teachers may edit materials only of programs used by a classroom they teach (the API enforces the same rule). */
function useCanEditMaterials(program: Program | undefined): boolean {
  const user = useCurrentUser();
  const classrooms = useClassroomsLookup();
  if (user.isAdmin) return true;
  if (!program || !user.isTeacher) return false;
  return (classrooms.data?.items ?? []).some((c) => c.programs.some((p) => p.program_id === program.id));
}

function ExistingProgram({ id }: { id: string }) {
  const user = useCurrentUser();
  const online = useOnline();
  const [params, setParams] = useUrlParams(URL_KEYS);
  const program = useQuery({ queryKey: learningKeys.program(id), queryFn: () => getProgram(id) });
  const versions = useQuery({ queryKey: learningKeys.versions(id), queryFn: () => getVersions(id), enabled: program.isSuccess });
  const canEditMaterials = useCanEditMaterials(program.data?.data) && !program.data?.data.archived;
  const [publishing, setPublishing] = useState(false);

  if (program.isLoading) return <LoadingRows rows={6} label="プログラムを読み込み中です" />;
  if (program.error || !program.data) {
    return (
      <>
        <PageHeader title={TITLE} crumbs={[...CRUMBS, { label: TITLE }]} />
        <Card>
          <ErrorState error={program.error} onRetry={() => void program.refetch()} />
        </Card>
      </>
    );
  }
  const p = program.data.data;
  const list = versions.data?.items;
  const selected = list ? (list.find((v) => v.id === params.version) ?? defaultVersion(list)) : null;
  const published = list?.find((v) => v.state === "published") ?? null;
  const canManage = user.isAdmin && !p.archived;

  const versionSelector = list && list.length ? (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="version-select" className="text-xs font-bold">
        公開状態・表示するバージョン
      </label>
      <Select id="version-select" value={selected?.id ?? ""} onChange={(e) => setParams({ version: e.target.value, unit: null })}>
        {list.map((v) => (
          <option key={v.id} value={v.id}>
            {versionOptionLabel(v)}
          </option>
        ))}
      </Select>
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title={TITLE}
        crumbs={[...CRUMBS, { label: p.name }]}
        description={user.isAdmin ? undefined : canEditMaterials ? "講師は下書きバージョンの教材を編集できます（単元・バージョンの変更は管理者が行います）。" : "閲覧のみです。"}
      />
      <div className="flex flex-col gap-5">
        {p.archived ? <Notice tone="warning">このプログラムはアーカイブ済みです。内容の閲覧のみできます。</Notice> : list ? <VersionNotice versions={list} selected={selected} /> : null}
        <ProgramInfoForm program={p} readOnly={!user.isAdmin} versionSelector={versionSelector} />
        <LastFetched checkedAt={program.data.checked_at} className="-mt-3 text-right" />
        <VersionPanel
          program={p}
          versions={list}
          checkedAt={versions.data?.checked_at ?? null}
          isLoading={versions.isLoading}
          error={versions.error}
          onRetry={() => void versions.refetch()}
          selectedId={selected?.id ?? null}
          onSelect={(vid) => setParams({ version: vid, unit: null })}
          canManage={canManage}
        />
        {selected ? (
          <UnitsPanel
            key={selected.id}
            version={selected}
            canEditUnits={canManage}
            canEditMaterials={canEditMaterials}
            selectedUnitId={params.unit || null}
            onSelectUnit={(uid) => setParams({ unit: uid }, { replace: true })}
          />
        ) : null}
        {canManage && published ? <EnrollmentPanel published={published} /> : null}
        {canManage && selected?.state === "draft" ? (
          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-[var(--radius-card)] sm:border">
            <p className="mr-auto text-xs text-muted">
              下書き {versionLabel(selected.version_number)}：単元 {selected.unit_count}件・教材 {selected.material_count}件
            </p>
            <Button onClick={() => setPublishing(true)} disabled={!online}>
              確認して公開
            </Button>
          </div>
        ) : null}
      </div>
      {publishing && selected ? <PublishVersionDialog open onOpenChange={setPublishing} version={selected} published={published} programId={p.id} /> : null}
    </>
  );
}

/** WEB-10 教育プログラム・教材を編集 (/programs/new and /programs/:id). */
export function ProgramEditPage() {
  const { id } = useParams();
  const user = useCurrentUser();
  if (id) return <ExistingProgram key={id} id={id} />;
  return (
    <>
      <PageHeader title="教育プログラムを登録" crumbs={[...CRUMBS, { label: "教育プログラムを登録" }]} />
      {user.isAdmin ? (
        <ProgramInfoForm program={null} readOnly={false} />
      ) : (
        <Card>
          <p className="text-sm">教育プログラムの登録は管理者のみ行えます。</p>
        </Card>
      )}
    </>
  );
}
