import { Type } from "@sinclair/typebox";

import type { MoltbotConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { readResponseText, withTimeout } from "./web-shared.js";

const DELVE_ACTIONS = ["delve", "stack_add", "vector_search"] as const;
const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 30_000;

const DelveToolSchema = Type.Object({
  action: stringEnum(DELVE_ACTIONS),
  baseUrl: Type.Optional(Type.String({ description: "Override Delve base URL." })),
  token: Type.Optional(Type.String({ description: "Override Delve API token." })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  agent_id: Type.Optional(Type.String({ description: "Agent id for stack_add." })),
  body: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Request payload for the selected action.",
    }),
  ),
});

type DelveToolConfig = NonNullable<MoltbotConfig["tools"]>["delve"] extends infer Delve
  ? Delve extends { [key: string]: unknown }
    ? Delve
    : undefined
  : undefined;

type DelveAction = (typeof DELVE_ACTIONS)[number];

type DelveRequestResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  message?: string;
  body?: unknown;
};

type DelveRequestParams = {
  baseUrl: string;
  token: string;
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
};

type NormalizedAction = {
  action: DelveAction;
  agentId?: string;
  body: Record<string, unknown>;
};

function resolveDelveConfig(cfg?: MoltbotConfig): DelveToolConfig {
  const delve = cfg?.tools?.delve;
  if (!delve || typeof delve !== "object") return undefined;
  return delve as DelveToolConfig;
}

function resolveDelveEnabled(params: { config?: DelveToolConfig }): boolean {
  if (typeof params.config?.enabled === "boolean") return params.config.enabled;
  return true;
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function resolveBaseUrl(
  override: string | undefined,
  config: DelveToolConfig | undefined,
): { baseUrl?: string; error?: string } {
  const fromArgs = override?.trim();
  if (fromArgs) {
    const normalized = normalizeBaseUrl(fromArgs);
    if (!normalized) return { error: "invalid_base_url" };
    return { baseUrl: normalized };
  }
  const fromConfig =
    config && "baseUrl" in config && typeof config.baseUrl === "string"
      ? config.baseUrl.trim()
      : "";
  if (fromConfig) {
    const normalized = normalizeBaseUrl(fromConfig);
    if (!normalized) return { error: "invalid_base_url" };
    return { baseUrl: normalized };
  }
  const fromEnv = readEnvVar("DELVE_BASE_URL");
  if (fromEnv) {
    const normalized = normalizeBaseUrl(fromEnv);
    if (!normalized) return { error: "invalid_base_url" };
    return { baseUrl: normalized };
  }
  return { baseUrl: DEFAULT_BASE_URL };
}

function resolveToken(override: string | undefined, config: DelveToolConfig | undefined): string {
  const fromArgs = override?.trim();
  if (fromArgs) return fromArgs;
  const fromConfig =
    config && "token" in config && typeof config.token === "string" ? config.token.trim() : "";
  if (fromConfig) return fromConfig;
  return readEnvVar("DELVE_TOKEN");
}

function resolveTimeoutMs(
  override: number | undefined,
  config: DelveToolConfig | undefined,
): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(1, Math.floor(override));
  }
  const fromConfig =
    config && "timeoutMs" in config && typeof config.timeoutMs === "number" ? config.timeoutMs : 0;
  if (Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.floor(fromConfig);
  }
  return DEFAULT_TIMEOUT_MS;
}

function readEnvVar(key: string): string {
  if (typeof globalThis !== "object" || !globalThis) return "";
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeActionParams(
  params: Record<string, unknown>,
): NormalizedAction | DelveRequestResult {
  const actionRaw = readStringParam(params, "action", { required: true });
  if (!DELVE_ACTIONS.includes(actionRaw as DelveAction)) {
    return {
      ok: false,
      error: "invalid_action",
      message: `Action must be one of: ${DELVE_ACTIONS.join(", ")}.`,
    };
  }
  const action = actionRaw as DelveAction;
  const body = params.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: "missing_body",
      message: "Request body must be a JSON object.",
    };
  }
  if (action === "stack_add") {
    const agentId = readStringParam(params, "agent_id", {
      label: "agent_id",
    });
    if (!agentId) {
      return {
        ok: false,
        error: "missing_agent_id",
        message: "agent_id is required for stack_add.",
      };
    }
    return { action, agentId, body: body as Record<string, unknown> };
  }
  return { action, body: body as Record<string, unknown> };
}

function resolveEndpoint(action: DelveAction, agentId?: string): string {
  if (action === "delve") return "/delve";
  if (action === "vector_search") return "/vector_store/search";
  return `/agents/${encodeURIComponent(agentId ?? "")}/stack/add`;
}

function isErrorResult(value: NormalizedAction | DelveRequestResult): value is DelveRequestResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === false;
}

async function requestDelve(params: DelveRequestParams): Promise<DelveRequestResult> {
  const url = new URL(params.path, `${params.baseUrl}/`).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: withTimeout(undefined, params.timeoutMs),
    });
    let payload: unknown = undefined;
    try {
      payload = await res.json();
    } catch {
      const text = await readResponseText(res);
      payload = text || undefined;
    }
    if (res.ok) {
      return { ok: true, status: res.status, data: payload };
    }
    return {
      ok: false,
      status: res.status,
      error: "request_failed",
      body: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    return { ok: false, error: "network_error", message };
  }
}

export function createDelveTool(options?: { config?: MoltbotConfig }): AnyAgentTool | null {
  const config = resolveDelveConfig(options?.config);
  if (!resolveDelveEnabled({ config })) return null;
  return {
    label: "Delve",
    name: "delve",
    description:
      "Query Delve knowledge graph, add stack messages, or run vector search (requires Delve API token).",
    parameters: DelveToolSchema,
    execute: async (_toolCallId: unknown, args: unknown) => {
      const params = args as Record<string, unknown>;
      const normalized = normalizeActionParams(params);
      if (isErrorResult(normalized)) {
        return jsonResult(normalized);
      }
      const { action, agentId, body } = normalized;
      const baseUrlOverride = readStringParam(params, "baseUrl");
      const tokenOverride = readStringParam(params, "token");
      const timeoutMs = resolveTimeoutMs(readNumberParam(params, "timeoutMs"), config);
      const baseUrl = resolveBaseUrl(baseUrlOverride, config);
      if (baseUrl.error) {
        return jsonResult({
          ok: false,
          error: "invalid_base_url",
          message: "Invalid Delve base URL. Provide a valid http(s) URL.",
        });
      }
      const token = resolveToken(tokenOverride, config);
      if (!token) {
        return jsonResult({
          ok: false,
          error: "missing_token",
          message: "Delve token is required. Set tools.delve.token or DELVE_TOKEN.",
        });
      }
      const path = resolveEndpoint(action, agentId);
      const result = await requestDelve({
        baseUrl: baseUrl.baseUrl ?? DEFAULT_BASE_URL,
        token,
        path,
        body,
        timeoutMs,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  normalizeBaseUrl,
  resolveBaseUrl,
  resolveEndpoint,
  resolveToken,
  resolveTimeoutMs,
  normalizeActionParams,
};
