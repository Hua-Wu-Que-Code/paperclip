import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {(() => {
        const map: Record<string, string> = {
          backlog: "待办", todo: "待办", in_progress: "进行中",
          in_review: "审核中", done: "已完成", cancelled: "已取消", blocked: "已阻塞",
        };
        return map[status] ?? status.replace(/_/g, " ");
      })()}
    </span>
  );
}
