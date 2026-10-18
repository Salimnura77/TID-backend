import { ValidationPipe, VersioningType } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import type { RuntimeConfig } from "../config/runtime-config";
import { ApiError } from "./api-error";
import { SafeExceptionFilter } from "./safe-exception.filter";
import { RequestContext } from "../logging/request-context";
import { StructuredLogger } from "../logging/structured-logger";
import { REQUEST_ID_HEADER, requestLogging } from "./request-logging.middleware";

export function configureHttp(app: NestExpressApplication, config: RuntimeConfig): void {
  app.disable("x-powered-by");
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  const context = app.get(RequestContext);
  const logger = app.get(StructuredLogger);
  // Correlation must precede parsers and CORS so their errors are covered too.
  app.use(requestLogging(context, logger));
  app.use(helmet());
  app.useBodyParser("json", { limit: "16kb", strict: true });
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new ApiError(403, "origin_not_allowed"));
    },
    credentials: false,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.useGlobalFilters(new SafeExceptionFilter(context, logger));
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
    exceptionFactory: () => new ApiError(400, "invalid_request"),
  }));
}
