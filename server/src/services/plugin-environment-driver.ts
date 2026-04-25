import type { Db } from "@paperclipai/db";
import type {
  EnvironmentProbeResult,
  PluginEnvironmentConfig,
  PluginEnvironmentDriverDeclaration,
} from "@paperclipai/shared";
import type {
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import { unprocessable } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export function pluginDriverProviderKey(config: Pick<PluginEnvironmentConfig, "pluginKey" | "driverKey">): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

export async function resolvePluginEnvironmentDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
}) {
  const pluginRegistry = pluginRegistryService(input.db);
  const plugin = await pluginRegistry.getByKey(input.config.pluginKey);
  if (!plugin || plugin.status !== "ready") {
    throw new Error(`插件环境驱动 "${pluginDriverProviderKey(input.config)}" 未就绪。`);
  }
  const driver = plugin.manifestJson.environmentDrivers?.find(
    (candidate) => candidate.driverKey === input.config.driverKey,
  );
  if (!driver) {
    throw new Error(`插件 "${input.config.pluginKey}" 未声明环境驱动 "${input.config.driverKey}"。`);
  }
  if (!input.workerManager.isRunning(plugin.id)) {
    throw new Error(`插件环境驱动 "${pluginDriverProviderKey(input.config)}" 没有运行中的工作器。`);
  }
  return { plugin, driver };
}

export async function resolvePluginEnvironmentDriverByKey(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  driverKey: string;
}) {
  return await resolvePluginSandboxProviderDriverByKey({
    db: input.db,
    driverKey: input.driverKey,
    workerManager: input.workerManager,
    requireRunning: true,
  });
}

export async function resolvePluginSandboxProviderDriverByKey(input: {
  db: Db;
  driverKey: string;
  workerManager?: PluginWorkerManager;
  requireRunning?: boolean;
}): Promise<{ plugin: Awaited<ReturnType<ReturnType<typeof pluginRegistryService>["list"]>>[number]; driver: PluginEnvironmentDriverDeclaration } | null> {
  const pluginRegistry = pluginRegistryService(input.db);
  const plugins = await pluginRegistry.list();
  for (const plugin of plugins) {
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === input.driverKey && candidate.kind === "sandbox_provider",
    ) as PluginEnvironmentDriverDeclaration | undefined;
    if (!driver) continue;
    if (input.requireRunning) {
      if (plugin.status !== "ready") continue;
      if (!input.workerManager?.isRunning(plugin.id)) continue;
    }
    return { plugin, driver };
  }
  return null;
}

export async function listReadyPluginEnvironmentDrivers(input: {
  db: Db;
  workerManager?: PluginWorkerManager;
}) {
  if (!input.workerManager) return [];
  const pluginRegistry = pluginRegistryService(input.db);
  const plugins = await pluginRegistry.list();
  return plugins.flatMap((plugin) => {
    if (plugin.status !== "ready" || !input.workerManager?.isRunning(plugin.id)) return [];
    return (plugin.manifestJson.environmentDrivers ?? [])
      .filter((driver) => driver.kind === "sandbox_provider")
      .map((driver) => ({
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        driverKey: driver.driverKey,
        displayName: driver.displayName,
        description: driver.description,
        configSchema: driver.configSchema,
      }));
  });
}

export async function validatePluginSandboxProviderConfig(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  provider: string;
  config: Record<string, unknown>;
}): Promise<{
  normalizedConfig: Record<string, unknown>;
  pluginId: string;
  pluginKey: string;
  driver: PluginEnvironmentDriverDeclaration;
}> {
  const resolved = await resolvePluginSandboxProviderDriverByKey({
    db: input.db,
    driverKey: input.provider,
    workerManager: input.workerManager,
    requireRunning: true,
  });
  if (!resolved) {
    throw unprocessable(`沙盒提供者 "${input.provider}" 未安装或其插件工作器未运行。`);
  }

  const result = await input.workerManager.call(resolved.plugin.id, "environmentValidateConfig", {
    driverKey: input.provider,
    config: input.config,
  });

  if (!result.ok) {
    throw unprocessable(
      result.errors?.[0] ?? `沙盒提供者 "${input.provider}" 拒绝了其配置。`,
      {
        errors: result.errors ?? [],
        warnings: result.warnings ?? [],
      },
    );
  }

  return {
    normalizedConfig: result.normalizedConfig ?? input.config,
    pluginId: resolved.plugin.id,
    pluginKey: resolved.plugin.pluginKey,
    driver: resolved.driver,
  };
}

export async function validatePluginEnvironmentDriverConfig(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentConfig> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  const result = await input.workerManager.call(plugin.id, "environmentValidateConfig", {
    driverKey: input.config.driverKey,
    config: input.config.driverConfig,
  });

  if (!result.ok) {
    throw unprocessable(
      result.errors?.[0] ?? `插件环境驱动 "${pluginDriverProviderKey(input.config)}" 拒绝了其配置。`,
      {
        errors: result.errors ?? [],
        warnings: result.warnings ?? [],
      },
    );
  }

  return {
    ...input.config,
    driverConfig: result.normalizedConfig ?? input.config.driverConfig,
  };
}

export async function probePluginEnvironmentDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  config: PluginEnvironmentConfig;
}): Promise<EnvironmentProbeResult> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  const result = await input.workerManager.call(plugin.id, "environmentProbe", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: input.config.driverConfig,
  });

  return {
    ok: result.ok,
    driver: "plugin",
    summary: result.summary ?? `插件环境驱动 "${pluginDriverProviderKey(input.config)}" 探测${result.ok ? "通过" : "失败"}。`,
    details: {
      pluginKey: input.config.pluginKey,
      driverKey: input.config.driverKey,
      diagnostics: result.diagnostics ?? [],
      metadata: result.metadata ?? {},
    },
  };
}

export async function probePluginSandboxProviderDriver(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  provider: string;
  config: Record<string, unknown>;
}): Promise<EnvironmentProbeResult> {
  const resolved = await resolvePluginEnvironmentDriverByKey({
    db: input.db,
    workerManager: input.workerManager,
    driverKey: input.provider,
  });
  if (!resolved) {
    return {
      ok: false,
      driver: "sandbox",
      summary: `沙盒提供者 "${input.provider}" 未安装或其插件工作器未运行。`,
      details: {
        provider: input.provider,
      },
    };
  }

  const { provider: _provider, ...driverConfig } = input.config;
  const result = await input.workerManager.call(resolved.plugin.id, "environmentProbe", {
    driverKey: input.provider,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: driverConfig,
  });

  return {
    ok: result.ok,
    driver: "sandbox",
    summary: result.summary ?? `沙盒提供者 "${input.provider}" 探测${result.ok ? "通过" : "失败"}。`,
    details: {
      provider: input.provider,
      pluginKey: resolved.plugin.pluginKey,
      diagnostics: result.diagnostics ?? [],
      metadata: result.metadata ?? {},
    },
  };
}

export async function resumePluginEnvironmentLease(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  config: PluginEnvironmentConfig;
  providerLeaseId: string;
  leaseMetadata?: Record<string, unknown>;
}): Promise<PluginEnvironmentLease> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  return await input.workerManager.call(plugin.id, "environmentResumeLease", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: input.config.driverConfig,
    providerLeaseId: input.providerLeaseId,
    leaseMetadata: input.leaseMetadata,
  });
}

export async function destroyPluginEnvironmentLease(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  companyId: string;
  environmentId: string;
  config: PluginEnvironmentConfig;
  providerLeaseId: string | null;
  leaseMetadata?: Record<string, unknown>;
}): Promise<void> {
  const { plugin } = await resolvePluginEnvironmentDriver(input);
  await input.workerManager.call(plugin.id, "environmentDestroyLease", {
    driverKey: input.config.driverKey,
    companyId: input.companyId,
    environmentId: input.environmentId,
    config: input.config.driverConfig,
    providerLeaseId: input.providerLeaseId,
    leaseMetadata: input.leaseMetadata,
  });
}

export async function realizePluginEnvironmentWorkspace(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  pluginId?: string | null;
  params: PluginEnvironmentRealizeWorkspaceParams;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentRealizeWorkspaceResult> {
  const { plugin } = input.pluginId
    ? { plugin: { id: input.pluginId } }
    : await resolvePluginEnvironmentDriver({
        db: input.db,
        workerManager: input.workerManager,
        config: input.config,
      });
  return await input.workerManager.call(plugin.id, "environmentRealizeWorkspace", input.params);
}

export async function executePluginEnvironmentCommand(input: {
  db: Db;
  workerManager: PluginWorkerManager;
  pluginId?: string | null;
  params: PluginEnvironmentExecuteParams;
  config: PluginEnvironmentConfig;
}): Promise<PluginEnvironmentExecuteResult> {
  const { plugin } = input.pluginId
    ? { plugin: { id: input.pluginId } }
    : await resolvePluginEnvironmentDriver({
        db: input.db,
        workerManager: input.workerManager,
        config: input.config,
      });
  return await input.workerManager.call(plugin.id, "environmentExecute", input.params);
}
