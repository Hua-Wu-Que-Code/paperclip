import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentDriver,
  FakeSandboxEnvironmentConfig,
  LocalEnvironmentConfig,
  PluginEnvironmentConfig,
  PluginSandboxEnvironmentConfig,
  SandboxEnvironmentConfig,
  SshEnvironmentConfig,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
import {
  resolvePluginSandboxProviderDriverByKey,
  validatePluginEnvironmentDriverConfig,
  validatePluginSandboxProviderConfig,
} from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
  writeConfigValueAtPath,
} from "./json-schema-secret-refs.js";

const secretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional().default("latest"),
}).strict();

const sshEnvironmentConfigSchema = z.object({
  host: z.string({ required_error: "SSH 环境需要一个主机地址。" }).trim().min(1, "SSH 环境需要一个主机地址。"),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string({ required_error: "SSH 环境需要一个用户名。" }).trim().min(1, "SSH 环境需要一个用户名。"),
  remoteWorkspacePath: z
    .string({ required_error: "SSH 环境需要一个远程工作区路径。" })
    .trim()
    .min(1, "SSH 环境需要一个远程工作区路径。")
    .refine((value) => value.startsWith("/"), "SSH 远程工作区路径必须是绝对路径。"),
  privateKey: z.null().optional().default(null),
  privateKeySecretRef: secretRefSchema.optional().nullable().default(null),
  knownHosts: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
  strictHostKeyChecking: z.boolean().optional().default(true),
}).strict();

const sshEnvironmentConfigProbeSchema = sshEnvironmentConfigSchema.extend({
  privateKey: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
}).strict();

const sshEnvironmentConfigPersistenceSchema = sshEnvironmentConfigProbeSchema;

const fakeSandboxEnvironmentConfigSchema = z.object({
  provider: z.literal("fake").default("fake"),
  image: z
    .string()
    .trim()
    .min(1, "模拟沙盒环境需要一个镜像。")
    .default("ubuntu:24.04"),
  reuseLease: z.boolean().optional().default(false),
}).strict();

const pluginSandboxProviderKeySchema = z.string()
  .trim()
  .min(1, "沙盒提供者是必填项。")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "沙盒提供者键必须以小写字母或数字开头，且仅包含小写字母、数字、点号、连字符或下划线",
  );

const pluginSandboxEnvironmentConfigSchema = z.object({
  provider: pluginSandboxProviderKeySchema,
  timeoutMs: z.coerce.number().int().min(1).max(86_400_000).optional(),
  reuseLease: z.boolean().optional().default(false),
}).catchall(z.unknown());

const pluginEnvironmentConfigSchema = z.object({
  pluginKey: z.string().min(1),
  driverKey: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "环境驱动键必须以小写字母或数字开头，且仅包含小写字母、数字、点号、连字符或下划线",
  ),
  driverConfig: z.record(z.unknown()).optional().default({}),
}).strict();

export type ParsedEnvironmentConfig =
  | { driver: "local"; config: LocalEnvironmentConfig }
  | { driver: "ssh"; config: SshEnvironmentConfig }
  | { driver: "sandbox"; config: SandboxEnvironmentConfig }
  | { driver: "plugin"; config: PluginEnvironmentConfig };

function toErrorMessage(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "无效的环境配置。";
  return first.message;
}

function getSandboxProvider(raw: Record<string, unknown>) {
  return typeof raw.provider === "string" && raw.provider.trim().length > 0 ? raw.provider.trim() : "fake";
}

function parseSandboxEnvironmentConfig(
  input: Record<string, unknown> | null | undefined,
) {
  const raw = parseObject(input);
  const provider = getSandboxProvider(raw);

  if (provider === "fake") {
    const parsed = fakeSandboxEnvironmentConfigSchema.safeParse(raw);
    return parsed.success
      ? ({ success: true as const, data: parsed.data satisfies FakeSandboxEnvironmentConfig })
      : ({ success: false as const, error: parsed.error });
  }

  const parsed = pluginSandboxEnvironmentConfigSchema.safeParse(raw);
  return parsed.success
    ? ({ success: true as const, data: parsed.data satisfies PluginSandboxEnvironmentConfig })
    : ({ success: false as const, error: parsed.error });
}

async function getSandboxProviderConfigSchema(
  db: Db,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const resolved = await resolvePluginSandboxProviderDriverByKey({
    db,
    driverKey: provider,
  });
  const schema = resolved?.driver.configSchema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : null;
}

function secretName(input: {
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
}) {
  const slug = input.environmentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "environment";
  return `environment-${input.driver}-${slug}-${input.field}-${randomUUID().slice(0, 8)}`;
}

async function createEnvironmentSecret(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
  value: string;
  actor?: { userId?: string | null; agentId?: string | null };
}) {
  const created = await secretService(input.db).create(
    input.companyId,
    {
      name: secretName(input),
      provider: "local_encrypted",
      value: input.value,
      description: `Secret for ${input.environmentName} ${input.field}.`,
    },
    input.actor,
  );
  return {
    type: "secret_ref" as const,
    secretId: created.id,
    version: "latest" as const,
  };
}

async function persistConfigSecretRefs(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown>;
  schema: Record<string, unknown> | null;
  actor?: { userId?: string | null; agentId?: string | null };
}): Promise<Record<string, unknown>> {
  let nextConfig = { ...input.config };
  for (const path of collectSecretRefPaths(input.schema)) {
    const rawValue = readConfigValueAtPath(nextConfig, path);
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      nextConfig = writeConfigValueAtPath(nextConfig, path, undefined);
      continue;
    }
    if (isUuidSecretRef(trimmed)) {
      nextConfig = writeConfigValueAtPath(nextConfig, path, trimmed);
      continue;
    }
    const created = await createEnvironmentSecret({
      db: input.db,
      companyId: input.companyId,
      environmentName: input.environmentName,
      driver: input.driver,
      field: path.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
      value: trimmed,
      actor: input.actor,
    });
    nextConfig = writeConfigValueAtPath(nextConfig, path, created.secretId);
  }
  return nextConfig;
}

async function resolveConfigSecretRefsForRuntime(input: {
  db: Db;
  companyId: string;
  config: Record<string, unknown>;
  schema: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  const secrets = secretService(input.db);
  let nextConfig = { ...input.config };
  for (const path of collectSecretRefPaths(input.schema)) {
    const current = readConfigValueAtPath(nextConfig, path);
    if (typeof current !== "string") continue;
    const trimmed = current.trim();
    if (!isUuidSecretRef(trimmed)) continue;
    nextConfig = writeConfigValueAtPath(
      nextConfig,
      path,
      await secrets.resolveSecretValue(input.companyId, trimmed, "latest"),
    );
  }
  return nextConfig;
}

export function stripSandboxProviderEnvelope(config: SandboxEnvironmentConfig): Record<string, unknown> {
  const { provider: _provider, ...driverConfig } = config as Record<string, unknown>;
  return driverConfig;
}

export function normalizeEnvironmentConfig(input: {
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  if (input.driver === "local") {
    return { ...parseObject(input.config) };
  }

  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies PluginEnvironmentConfig;
  }

  throw unprocessable(`不支持的环境驱动 "${input.driver}"。`);
}

export function normalizeEnvironmentConfigForProbe(input: {
  db: Db;
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
  pluginWorkerManager?: PluginWorkerManager;
}): Promise<Record<string, unknown>> | Record<string, unknown> {
  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigProbeSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.provider === "fake") {
      return parsed.data;
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("沙盒提供者配置验证需要运行中的插件工作器管理器。");
    }
    return validatePluginSandboxProviderConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      provider: parsed.data.provider,
      config: stripSandboxProviderEnvelope(parsed.data),
    }).then((validated) => ({
      provider: parsed.data.provider,
      ...validated.normalizedConfig,
    }));
  }

  return normalizeEnvironmentConfig({
    driver: input.driver,
    config: input.config,
  });
}

export async function normalizeEnvironmentConfigForPersistence(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
  actor?: { userId?: string | null; agentId?: string | null };
  pluginWorkerManager?: PluginWorkerManager;
}): Promise<Record<string, unknown>> {
  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigPersistenceSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    const secrets = secretService(input.db);
    const { privateKey, ...stored } = parsed.data;
    let nextPrivateKeySecretRef = stored.privateKeySecretRef;
    if (privateKey) {
      nextPrivateKeySecretRef = await createEnvironmentSecret({
        db: input.db,
        companyId: input.companyId,
        environmentName: input.environmentName,
        driver: input.driver,
        field: "private-key",
        value: privateKey,
        actor: input.actor,
      });
      if (
        stored.privateKeySecretRef &&
        stored.privateKeySecretRef.secretId !== nextPrivateKeySecretRef.secretId
      ) {
        await secrets.remove(stored.privateKeySecretRef.secretId);
      }
    }
    return {
      ...stored,
      privateKey: null,
      privateKeySecretRef: nextPrivateKeySecretRef,
    } satisfies SshEnvironmentConfig;
  }

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config);
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.provider === "fake") {
      throw unprocessable(
        "内置模拟沙盒环境仅供内部探测使用，无法保存。",
      );
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("沙盒提供者配置验证需要运行中的插件工作器管理器。");
    }
    const validated = await validatePluginSandboxProviderConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      provider: parsed.data.provider,
      config: stripSandboxProviderEnvelope(parsed.data),
    });
    return await persistConfigSecretRefs({
      db: input.db,
      companyId: input.companyId,
      environmentName: input.environmentName,
      driver: input.driver,
      config: {
        provider: parsed.data.provider,
        ...validated.normalizedConfig,
      },
      schema:
        validated.driver.configSchema && typeof validated.driver.configSchema === "object" && !Array.isArray(validated.driver.configSchema)
          ? validated.driver.configSchema as Record<string, unknown>
          : null,
      actor: input.actor,
    });
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("插件环境配置验证需要运行中的插件工作器管理器。");
    }
    return { ...(await validatePluginEnvironmentDriverConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      config: parsed.data,
    })) };
  }

  return normalizeEnvironmentConfig({
    driver: input.driver,
    config: input.config,
  });
}

export async function resolveEnvironmentDriverConfigForRuntime(
  db: Db,
  companyId: string,
  environment: Pick<Environment, "driver" | "config">,
): Promise<ParsedEnvironmentConfig> {
  const parsed = parseEnvironmentDriverConfig(environment);
  const secrets = secretService(db);

  if (parsed.driver === "ssh" && parsed.config.privateKeySecretRef) {
    return {
      driver: "ssh",
      config: {
        ...parsed.config,
        privateKey: await secrets.resolveSecretValue(
          companyId,
          parsed.config.privateKeySecretRef.secretId,
          parsed.config.privateKeySecretRef.version ?? "latest",
        ),
      },
    };
  }

  if (parsed.driver === "sandbox" && parsed.config.provider !== "fake") {
    return {
      driver: "sandbox",
      config: await resolveConfigSecretRefsForRuntime({
        db,
        companyId,
        config: parsed.config as Record<string, unknown>,
        schema: await getSandboxProviderConfigSchema(db, parsed.config.provider),
      }) as SandboxEnvironmentConfig,
    };
  }

  return parsed;
}

export function readSshEnvironmentPrivateKeySecretId(
  environment: Pick<Environment, "driver" | "config">,
): string | null {
  if (environment.driver !== "ssh") return null;
  const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(environment.config));
  if (!parsed.success) return null;
  return parsed.data.privateKeySecretRef?.secretId ?? null;
}

export function parseEnvironmentDriverConfig(
  environment: Pick<Environment, "driver" | "config">,
): ParsedEnvironmentConfig {
  if (environment.driver === "local") {
    return {
      driver: "local",
      config: { ...parseObject(environment.config) },
    };
  }

  if (environment.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "ssh",
      config: parsed,
    };
  }

  if (environment.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(environment.config);
    if (!parsed.success) {
      throw parsed.error;
    }
    return {
      driver: "sandbox",
      config: parsed.data,
    };
  }

  if (environment.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "plugin",
      config: parsed,
    };
  }

  throw new Error(`不支持的环境驱动 "${environment.driver}"。`);
}
