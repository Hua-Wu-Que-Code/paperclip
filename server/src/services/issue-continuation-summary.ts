import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issues } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { documentService } from "./documents.js";

export { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
export const ISSUE_CONTINUATION_SUMMARY_TITLE = "续接摘要";
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;
const SUMMARY_SECTION_MAX_CHARS = 1_200;
const PATH_CANDIDATE_RE = /(?:^|[\s`"'(])((?:server|ui|packages|doc|scripts|\.github)\/[A-Za-z0-9._/-]+)/g;

type IssueSummaryInput = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

type RunSummaryInput = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  finishedAt?: Date | null;
};

type AgentSummaryInput = {
  id: string;
  name: string;
  adapterType: string | null;
};

export type IssueContinuationSummaryDocument = {
  key: typeof ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY;
  title: string | null;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedAt: Date;
};

function truncateText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[已截断]`;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readResultSummary(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return (
    asNonEmptyString(resultJson.summary) ??
    asNonEmptyString(resultJson.result) ??
    asNonEmptyString(resultJson.message) ??
    asNonEmptyString(resultJson.error) ??
    null
  );
}

function extractMarkdownSection(markdown: string | null | undefined, heading: string) {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section ? truncateText(section, SUMMARY_SECTION_MAX_CHARS) : null;
}

function extractPathCandidates(...texts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const path = match[1]?.replace(/[),.;:]+$/, "");
      if (path) seen.add(path);
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function inferMode(issue: IssueSummaryInput, run: RunSummaryInput) {
  if (issue.status === "done" || issue.status === "in_review") return "review";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled") return "implementation";
  if (issue.status === "backlog" || issue.status === "todo") return "plan";
  return "implementation";
}

function inferNextAction(issue: IssueSummaryInput, run: RunSummaryInput, previousNextAction: string | null) {
  if (issue.status === "done") return "审查已完成的问题输出并关闭所有剩余的后续评论。";
  if (issue.status === "in_review") return "等待审阅者反馈或批准后再继续执行器工作。";
  if (run.status === "failed" || run.status === "timed_out") {
    return "检查失败的运行，修复原因，并从上述最近的具体操作恢复。";
  }
  if (run.status === "cancelled") return "在启动另一次运行之前确认取消原因。";
  return previousNextAction ?? "从验收标准、最新评论和此摘要恢复实施。";
}

function bulletList(items: string[], empty: string) {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function extractPreviousNextAction(previousBody: string | null | undefined) {
  const section = extractMarkdownSection(previousBody, "下一步行动");
  if (!section) return null;
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? null;
}

export function buildContinuationSummaryMarkdown(input: {
  issue: IssueSummaryInput;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
  previousSummaryBody?: string | null;
}) {
  const { issue, run, agent } = input;
  const resultSummary = readResultSummary(run.resultJson);
  const recentActions = [
    `运行 \`${run.id}\` 已完成，状态为 \`${run.status}\`${run.finishedAt ? `（${run.finishedAt.toISOString()}）` : ""}。`,
    resultSummary ? truncateText(resultSummary, SUMMARY_SECTION_MAX_CHARS) : "此运行未捕获适配器提供的结果摘要。",
  ];
  if (run.error) {
    recentActions.push(`最新运行错误${run.errorCode ? `（${run.errorCode}）` : ""}：${truncateText(run.error, 500)}`);
  }

  const paths = extractPathCandidates(resultSummary, run.stdoutExcerpt, run.stderrExcerpt, input.previousSummaryBody);
  const objective = extractMarkdownSection(issue.description, "Objective") ?? issue.description?.trim() ?? "未捕获目标。";
  const acceptanceCriteria = extractMarkdownSection(issue.description, "Acceptance Criteria") ?? "未捕获明确的验收标准。";
  const mode = inferMode(issue, run);
  const nextAction = inferNextAction(issue, run, extractPreviousNextAction(input.previousSummaryBody));

  const body = [
    "# 续接摘要",
    "",
    `- 问题：${issue.identifier ?? issue.id} — ${issue.title}`,
    `- 状态：${issue.status}`,
    `- 优先级：${issue.priority}`,
    `- 当前模式：${mode}`,
    `- 最后更新运行：${run.id}`,
    `- 代理：${agent.name}（${agent.adapterType ?? "未知"}）`,
    "",
    "## 目标",
    "",
    truncateText(objective, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## 验收标准",
    "",
    acceptanceCriteria,
    "",
    "## 最近具体操作",
    "",
    bulletList(recentActions, "未捕获最近操作。"),
    "",
    "## 涉及的文件/路由",
    "",
    bulletList(paths.map((path) => `\`${path}\``), "在捕获的运行摘要中未检测到文件或路由路径。"),
    "",
    "## 已执行命令",
    "",
    bulletList(
      [
        `心跳运行 \`${run.id}\` 调用了适配器 \`${agent.adapterType ?? "未知"}\`。`,
        "详细的 shell/工具命令保留在运行日志和记录中。",
      ],
      "未捕获命令元数据。",
    ),
    "",
    "## 阻塞项/决策",
    "",
    bulletList(
      run.error
        ? [`最新运行以 \`${run.status}\` 结束；请在继续之前检查错误。`]
        : ["最新运行未记录新的阻塞项。"],
      "未捕获阻塞项或决策。",
    ),
    "",
    "## 下一步行动",
    "",
    `- ${nextAction}`,
  ].join("\n");

  return truncateText(body, ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
}

export async function getIssueContinuationSummaryDocument(
  db: Db,
  issueId: string,
): Promise<IssueContinuationSummaryDocument | null> {
  const row = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: row.title,
    body: row.body,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    updatedAt: row.updatedAt,
  };
}

export async function refreshIssueContinuationSummary(input: {
  db: Db;
  issueId: string;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
}) {
  const { db, issueId, run, agent } = input;
  const [issue, existing] = await Promise.all([
    db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null),
    getIssueContinuationSummaryDocument(db, issueId),
  ]);

  if (!issue) return null;
  const body = buildContinuationSummaryMarkdown({
    issue,
    run,
    agent,
    previousSummaryBody: existing?.body ?? null,
  });
  const result = await documentService(db).upsertIssueDocument({
    issueId,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: ISSUE_CONTINUATION_SUMMARY_TITLE,
    format: "markdown",
    body,
    baseRevisionId: existing?.latestRevisionId ?? null,
    changeSummary: `在运行 ${run.id} 后刷新续接摘要`,
    createdByAgentId: agent.id,
    createdByRunId: run.id,
  });
  return result.document;
}
