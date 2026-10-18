import { ERROR_MESSAGES } from "../http/api-error";
import { RequestContext } from "./request-context";
import { LOG_LEVELS } from "./log-level";
import type { LogLevel } from "./log-level";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "OTHER"] as const;
export const HTTP_ROUTES = ["health_readiness", "health_liveness", "account_self", "verification_submit", "verification_read", "credential_issue", "credential_check", "credential_status", "credential_revoke", "consent_partner", "consent_invitation", "consent_list", "consent_read", "consent_history", "consent_decision", "consent_revoke", "partner_request", "partner_request_read", "partner_disclosure", "unmatched"] as const;

const eventLevels = {
  service_started: "info",
  startup_failed: "error",
  database_unavailable: "warn",
  migrations_applied: "info",
  migration_failed: "error",
  http_request: "info",
  http_error: "warn",
} as const satisfies Record<string, LogLevel>;
export type LogEvent = keyof typeof eventLevels;
export type LogSink = (line: string, level: LogLevel) => void;

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function defaultSink(line: string, level: LogLevel): void {
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export class StructuredLogger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly context = new RequestContext(),
    private readonly sink: LogSink = defaultSink,
  ) {}

  emit(event: LogEvent, metadata: unknown = {}): void {
    if (!Object.hasOwn(eventLevels, event)) return;
    const source = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
    const status = source.statusCode;
    const level: LogLevel = event === "http_error" && integer(status, 500, 599) ? "error" : eventLevels[event];
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
    const entry: Record<string, string | number | boolean> = { time: new Date().toISOString(), level, event };

    // Redaction is an event-specific allowlist. Never serialize arbitrary objects,
    // messages, exceptions, bodies, headers, URLs, credentials or attribute values.
    if (event === "http_request" || event === "http_error") {
      const requestId = this.context.requestId ?? source.requestId;
      if (typeof requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
        entry.requestId = requestId;
      }
      if (integer(status, 100, 599)) entry.statusCode = status;
    }
    if (event === "http_request") {
      if (typeof source.method === "string" && HTTP_METHODS.some((method) => method === source.method)) entry.method = source.method;
      if (typeof source.route === "string" && HTTP_ROUTES.some((route) => route === source.route)) entry.route = source.route;
      if (typeof source.durationMs === "number" && Number.isFinite(source.durationMs) && source.durationMs >= 0) {
        entry.durationMs = Math.round(source.durationMs);
      }
      if (typeof source.aborted === "boolean") entry.aborted = source.aborted;
    }
    if (event === "http_error" && typeof source.code === "string" && Object.hasOwn(ERROR_MESSAGES, source.code)) entry.code = source.code;
    if (event === "service_started" && integer(source.port, 1, 65535)) entry.port = source.port;
    if (event === "migrations_applied" && integer(source.count, 0, Number.MAX_SAFE_INTEGER)) entry.count = source.count;
    this.sink(`${JSON.stringify(entry)}\n`, level);
  }
}
