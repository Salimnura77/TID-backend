import { Catch, HttpException } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ApiError, ERROR_MESSAGES } from "./api-error";
import type { ErrorCode } from "./api-error";
import type { RequestContext } from "../logging/request-context";
import type { StructuredLogger } from "../logging/structured-logger";

const codesByStatus: Readonly<Record<number, ErrorCode>> = {
  400: "invalid_request", 401: "unauthenticated", 403: "forbidden",
  404: "not_found", 405: "method_not_allowed", 413: "payload_too_large",
  429: "rate_limited", 503: "service_unavailable",
};

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly context: RequestContext, private readonly logger: StructuredLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    let status = error instanceof HttpException ? error.getStatus() : 500;
    // Express's parser errors do not always extend Nest's HttpException.
    if (error instanceof Error && "type" in error) {
      if (error.type === "entity.too.large") status = 413;
      if (error.type === "entity.parse.failed") status = 400;
    }
    const code = error instanceof ApiError
      ? error.code
      : (codesByStatus[status] ?? (status < 500 ? "invalid_request" : "internal_error"));
    // Do not serialize exception messages, validation targets, URLs, or values.
    this.logger.emit("http_error", { statusCode: status, code });
    const response = host.switchToHttp().getResponse<Response>();
    if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="TrueID"');
    response.status(status).json({
      demo: true, requestId: this.context.requestId, error: { code, message: ERROR_MESSAGES[code] },
    });
  }
}
