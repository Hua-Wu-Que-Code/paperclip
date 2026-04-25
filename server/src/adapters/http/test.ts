import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeMethod(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : "POST";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "");
  const method = normalizeMethod(asString(config.method, "POST"));

  if (!urlValue) {
    checks.push({
      code: "http_url_missing",
      level: "error",
      message: "HTTP 适配器需要一个 URL。",
      hint: "请将 adapterConfig.url 设置为绝对 http(s) 端点。",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "http_url_invalid",
      level: "error",
      message: `无效的 URL：${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "http_url_protocol_invalid",
      level: "error",
      message: `不支持的 URL 协议：${url.protocol}`,
      hint: "请使用 http:// 或 https:// 端点。",
    });
  }

  if (url) {
    checks.push({
      code: "http_url_valid",
      level: "info",
      message: `已配置的端点：${url.toString()}`,
    });
  }

  checks.push({
    code: "http_method_configured",
    level: "info",
    message: `已配置的方法：${method}`,
  });

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 405 && response.status !== 501) {
        checks.push({
          code: "http_endpoint_probe_unexpected_status",
          level: "warn",
          message: `端点探测返回 HTTP ${response.status}。`,
          hint: "请验证该端点可从 Paperclip 服务器主机访问。",
        });
      } else {
        checks.push({
          code: "http_endpoint_probe_ok",
          level: "info",
          message: "端点已响应 HEAD 探测。",
        });
      }
    } catch (err) {
      checks.push({
        code: "http_endpoint_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "端点探测失败",
        hint: "在受限网络中可能是正常现象；请在调用运行时验证连接。",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
