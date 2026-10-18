import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Server } from "node:http";
import { AppModule } from "./app.module";
import { APP_CONFIG } from "./config/runtime-config";
import type { RuntimeConfig } from "./config/runtime-config";
import { configureHttp } from "./http/configure-http";
import { StructuredLogger } from "./logging/structured-logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false, abortOnError: false, bodyParser: false,
  });
  try {
    const config = app.get<RuntimeConfig>(APP_CONFIG);
    configureHttp(app, config);
    app.enableShutdownHooks();
    await app.listen(config.port, config.host);
    const server: Server = app.getHttpServer();
    server.requestTimeout = 10_000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    app.get(StructuredLogger).emit("service_started", { port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  new StructuredLogger().emit("startup_failed");
  process.exitCode = 1;
});
