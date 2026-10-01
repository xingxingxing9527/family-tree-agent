import type { AppResult } from "../../shared/contracts.js";

export interface HttpErrorPayload {
  statusCode: number;
  body: AppResult<never>;
}

export function invalidRpcRequest(field = "request"): HttpErrorPayload {
  return {
    statusCode: 400,
    body: { ok: false, error: { code: "VALIDATION", message: "Invalid RPC request", details: { field } } }
  };
}

export function mapUnexpectedRpcError(): HttpErrorPayload {
  return {
    statusCode: 500,
    body: { ok: false, error: { code: "INTERNAL", message: "Unable to complete RPC request" } }
  };
}

const publicCodes = new Set(["VALIDATION", "NOT_FOUND", "CONFLICT", "PATH_DENIED", "MODEL_UNAVAILABLE", "INTERNAL"]);
const pathLike = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var)\/|databasePath|mediaPath)/u;

export function sanitizeRpcResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== false) return value;
  const rawError = (value as { error?: unknown }).error;
  if (!rawError || typeof rawError !== "object") return mapUnexpectedRpcError().body;
  const source = rawError as Record<string, unknown>;
  const code = typeof source.code === "string" && publicCodes.has(source.code) ? source.code : "INTERNAL";
  const rawMessage = typeof source.message === "string" ? source.message.slice(0, 500) : "Request could not be completed";
  const message = code === "INTERNAL" || pathLike.test(rawMessage) ? "Unable to complete RPC request" : rawMessage;
  const details = source.details && typeof source.details === "object" && !Array.isArray(source.details)
    ? Object.fromEntries(Object.entries(source.details as Record<string, unknown>).filter(([key, item]) =>
      ["field", "entityId", "entityType", "expectedVersion", "actualVersion", "code"].includes(key) &&
      (typeof item === "string" || typeof item === "number" || typeof item === "boolean") &&
      !pathLike.test(String(item))))
    : undefined;
  return {
    ok: false,
    error: { code, message, ...(details && Object.keys(details).length > 0 ? { details } : {}) }
  };
}
