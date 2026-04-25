import { useEffect } from "react";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "仪表盘", href: "/dashboard" },
      { label: "实时运行" },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? "创建公司以查看实时运行。" : "选择公司以查看实时运行。"}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            仪表盘
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">实时智能体运行</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            活跃运行优先，其后为最近完成的运行。
          </p>
        </div>
        <div className="text-sm text-muted-foreground">最多显示 {DASHBOARD_LIVE_RUN_LIMIT} 条</div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title="活跃/近期"
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-[420px]"
        emptyMessage="暂无活跃或近期的智能体运行。"
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
