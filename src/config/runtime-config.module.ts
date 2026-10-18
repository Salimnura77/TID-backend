import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, readConfig } from "./runtime-config";

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => readConfig() }],
  exports: [APP_CONFIG],
})
export class RuntimeConfigModule {}
