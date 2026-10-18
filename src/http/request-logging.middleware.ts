import { performance } from "node:perf_hooks";
import type { Request, RequestHandler } from "express";
import type { RequestContext } from "../logging/request-context";
import { HTTP_METHODS } from "../logging/structured-logger";
import type { StructuredLogger } from "../logging/structured-logger";

export const REQUEST_ID_HEADER = "X-Request-Id";

function routeLabel(request: Request): string {
  const route: unknown = request.route?.path;
  if (route === "/api/v1/health") return "health_readiness";
  if (route === "/api/v1/health/live") return "health_liveness";
  if (route === "/api/v1/users/me") return "account_self";
  if (route === "/api/v1/verifications") return "verification_submit";
  if (route === "/api/v1/verifications/:id") return "verification_read";
  if (route === "/api/v1/credentials") return "credential_issue";
  if (route === "/api/v1/credentials/check") return "credential_check";
  if (route === "/api/v1/credentials/:id/status") return "credential_status";
  if (route === "/api/v1/credentials/:id/revoke") return "credential_revoke";
  if (route === "/api/v1/consent/partners/:id") return "consent_partner";
  if (route === "/api/v1/consent/invitations") return "consent_invitation";
  if (route === "/api/v1/consent/requests") return "consent_list";
  if (route === "/api/v1/consent/requests/:id") return "consent_read";
  if (route === "/api/v1/consent/requests/:id/history") return "consent_history";
  if (route === "/api/v1/consent/requests/:id/decision") return "consent_decision";
  if (route === "/api/v1/consent/requests/:id/revoke") return "consent_revoke";
  if (route === "/api/v1/partner/requests") return "partner_request";
  if (route === "/api/v1/partner/requests/:id") return "partner_request_read";
  if (route === "/api/v1/partner/requests/:id/disclosure") return "partner_disclosure";
  // Never log raw paths, unmatched URLs, query strings, or parameter values.
  return "unmatched";
}

export function requestLogging(context: RequestContext, logger: StructuredLogger): RequestHandler {
  return (request, response, next) => context.withRequest(() => {
    const requestId = context.requestId!;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const started = performance.now();
    let logged = false;
    const complete = (aborted: boolean): void => {
      if (logged) return;
      logged = true;
      logger.emit("http_request", {
        requestId,
        method: HTTP_METHODS.some((method) => method === request.method) ? request.method : "OTHER",
        route: routeLabel(request),
        statusCode: response.statusCode,
        durationMs: performance.now() - started,
        aborted,
      });
    };
    response.once("finish", () => complete(false));
    response.once("close", () => complete(!response.writableFinished));
    next();
  });
}
