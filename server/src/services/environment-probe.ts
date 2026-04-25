import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: { pluginWorkerManager?: PluginWorkerManager; resolvedConfig?: ParsedEnvironmentConfig } = {},
): Promise<EnvironmentProbeResult> {
  const parsed = options.resolvedConfig ?? await resolveEnvironmentDriverConfigForRuntime(db, environment.companyId, environment);

  if (parsed.driver === "local") {
    return {
      ok: true,
      driver: "local",
      summary: "此 Paperclip 主机上的本地环境可用。",
      details: {
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
    };
  }

  if (parsed.driver === "sandbox") {
    if (!isBuiltinSandboxProvider(parsed.config.provider)) {
      if (!options.pluginWorkerManager) {
        return {
          ok: false,
          driver: "sandbox",
          summary: `沙盒提供者 "${parsed.config.provider}" 需要运行中的提供者插件。`,
          details: {
            provider: parsed.config.provider,
          },
        };
      }
      return await probePluginSandboxProviderDriver({
        db,
        workerManager: options.pluginWorkerManager,
        companyId: environment.companyId,
        environmentId: environment.id,
        provider: parsed.config.provider,
        config: parsed.config as unknown as Record<string, unknown>,
      });
    }
    return await probeSandboxProvider(parsed.config);
  }

  if (parsed.driver === "plugin") {
    if (!options.pluginWorkerManager) {
      return {
        ok: false,
        driver: "plugin",
        summary: `插件环境探测需要 "${parsed.config.pluginKey}:${parsed.config.driverKey}" 的插件工作器管理器。`,
        details: {
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      };
    }
    return await probePluginEnvironmentDriver({
      db,
      workerManager: options.pluginWorkerManager,
      companyId: environment.companyId,
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  try {
    const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);

    return {
      ok: true,
      driver: "ssh",
      summary: `已连接到 ${parsed.config.username}@${parsed.config.host} 并验证了远程工作区路径。`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        remoteCwd,
      },
    };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    const message =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : String(error)) ||
      "SSH 探测失败。";

    return {
      ok: false,
      driver: "ssh",
      summary: `${parsed.config.username}@${parsed.config.host} 的 SSH 探测失败。`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        error: message,
        code,
      },
    };
  }
}
