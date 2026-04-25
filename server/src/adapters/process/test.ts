import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
} from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "");
  const cwd = asString(config.cwd, process.cwd());

  if (!command) {
    checks.push({
      code: "process_command_missing",
      level: "error",
      message: "进程适配器需要一个命令。",
      hint: "请将 adapterConfig.command 设置为可执行命令。",
    });
  } else {
    checks.push({
      code: "process_command_present",
      level: "info",
      message: `已配置的命令：${command}`,
    });
  }

  try {
    await ensureAbsoluteDirectory(cwd);
    checks.push({
      code: "process_cwd_valid",
      level: "info",
      message: `工作目录有效：${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "process_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "无效的工作目录",
      detail: cwd,
    });
  }

  if (command) {
    const envConfig = parseObject(config.env);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === "string") env[key] = value;
    }
    const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({
        code: "process_command_resolvable",
        level: "info",
        message: `命令可执行：${command}`,
      });
    } catch (err) {
      checks.push({
        code: "process_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "命令不可执行",
        detail: command,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
