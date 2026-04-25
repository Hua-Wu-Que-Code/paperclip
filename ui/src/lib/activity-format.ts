import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": "创建了",
  "issue.updated": "更新了",
  "issue.checked_out": "签出了",
  "issue.released": "释放了",
  "issue.comment_added": "评论了",
  "issue.comment_cancelled": "取消了一条排队中的评论：",
  "issue.attachment_added": "添加了附件到",
  "issue.attachment_removed": "移除了附件：",
  "issue.document_created": "创建了文档：",
  "issue.document_updated": "更新了文档：",
  "issue.document_deleted": "删除了文档：",
  "issue.commented": "评论了",
  "issue.deleted": "删除了",
  "agent.created": "创建了",
  "agent.updated": "更新了",
  "agent.paused": "暂停了",
  "agent.resumed": "恢复了",
  "agent.terminated": "终止了",
  "agent.key_created": "创建了 API 密钥：",
  "agent.budget_updated": "更新了预算：",
  "agent.runtime_session_reset": "重置了会话：",
  "heartbeat.invoked": "触发了心跳：",
  "heartbeat.cancelled": "取消了心跳：",
  "approval.created": "请求审批",
  "approval.approved": "批准了",
  "approval.rejected": "拒绝了",
  "project.created": "创建了",
  "project.updated": "更新了",
  "project.deleted": "删除了",
  "goal.created": "创建了",
  "goal.updated": "更新了",
  "goal.deleted": "删除了",
  "cost.reported": "报告了费用：",
  "cost.recorded": "记录了费用：",
  "company.created": "创建了公司",
  "company.updated": "更新了公司",
  "company.archived": "归档了",
  "company.budget_updated": "更新了预算：",
  "environment.lease_acquired": "获取了环境租约",
  "environment.lease_released": "释放了环境租约",
  "issue.read_marked": "标记已读",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "创建了任务",
  "issue.updated": "更新了任务",
  "issue.checked_out": "签出了任务",
  "issue.released": "释放了任务",
  "issue.comment_added": "添加了评论",
  "issue.comment_cancelled": "取消了一条排队中的评论",
  "issue.feedback_vote_saved": "保存了对 AI 输出的反馈",
  "issue.attachment_added": "添加了附件",
  "issue.attachment_removed": "移除了附件",
  "issue.document_created": "创建了文档",
  "issue.document_updated": "更新了文档",
  "issue.document_deleted": "删除了文档",
  "issue.deleted": "删除了任务",
  "agent.created": "创建了智能体",
  "agent.updated": "更新了智能体",
  "agent.paused": "暂停了智能体",
  "agent.resumed": "恢复了智能体",
  "agent.terminated": "终止了智能体",
  "heartbeat.invoked": "触发了一次心跳",
  "heartbeat.cancelled": "取消了一次心跳",
  "approval.created": "请求了审批",
  "approval.approved": "批准了",
  "approval.rejected": "拒绝了",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "无");
  // Translate known status values
  const statusMap: Record<string, string> = {
    "todo": "待处理",
    "in_progress": "进行中",
    "in_review": "审核中",
    "done": "已完成",
    "blocked": "已阻塞",
    "cancelled": "已取消",
    "backlog": "待处理",
    "revision_requested": "修订中",
    "pending": "待定",
    "paused": "已暂停",
    "active": "活跃",
    "error": "错误",
    "terminated": "已终止",
    "pending_approval": "待审批",
    "urgent": "紧急",
    "high": "高",
    "medium": "中",
    "low": "低",
    "none": "无",
  };
  return statusMap[value] ?? value.replace(/_/g, " ");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId || userId === "local-board") return "董事会";
  if (options.currentUserId && userId === options.currentUserId) return "你";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `用户 ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? "智能体";
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return "任务";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? `将状态从 ${humanizeValue(from)} 改为 ${humanizeValue(details.status)}`
      : `将状态改为 ${humanizeValue(details.status)}`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? `将优先级从 ${humanizeValue(from)} 改为 ${humanizeValue(details.priority)}`
      : `将优先级改为 ${humanizeValue(details.priority)}`;
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "智能体";
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? `将状态从 ${humanizeValue(from)} 改为 ${humanizeValue(details.status)}`
        : `将状态改为 ${humanizeValue(details.status)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `将优先级从 ${humanizeValue(from)} 改为 ${humanizeValue(details.priority)}`
        : `将优先级改为 ${humanizeValue(details.priority)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? `将任务指派给 ${assigneeName}` : "取消了指派");
  }
  if (details.title !== undefined) parts.push("更新了标题");
  if (details.description !== undefined) parts.push("更新了描述");

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("阻塞项", "阻塞项", added);
      return input.forIssueDetail ? `添加了 ${changed}` : `添加了 ${changed} 到`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("阻塞项", "阻塞项", removed);
      return input.forIssueDetail ? `移除了 ${changed}` : `移除了 ${changed} 从`;
    }
    return input.forIssueDetail ? "更新了阻塞项" : "更新了阻塞项";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "评审人" : "审批人";
    const plural = input.action === "issue.reviewers_updated" ? "评审人" : "审批人";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `添加了 ${changed}` : `添加了 ${changed} 到`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? `移除了 ${changed}` : `移除了 ${changed} 从`;
    }
    return input.forIssueDetail ? `更新了${plural}` : `更新了${plural}`;
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "文档";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
