import { PageHeader } from "../../components/ui/PageHeader";

export function StudentProgressPage() {
  return <PageHeader title="教育進捗" crumbs={[{ label: "社員教育進捗管理", to: "/progress" }, { label: "教育進捗" }]} />;
}
