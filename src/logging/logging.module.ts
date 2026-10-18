import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { RuntimeConfigModule } from "../config/runtime-config.module";
import { RequestContext } from "./request-context";
import { StructuredLogger } from "./structured-logger";

@Global()
@Module({
  imports: [RuntimeConfigModule],
  providers: [RequestContext, {
    provide: StructuredLogger,
    inject: [APP_CONFIG, RequestContext],
    useFactory: (config: RuntimeConfig, context: RequestContext) => new StructuredLogger(config.logLevel, context),
  }],
  exports: [RequestContext, StructuredLogger],
})
export class LoggingModule {}
