import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { DatabaseModule } from "../database/database.module";
import { UsersModule } from "../users/users.module";
import { AuditModule } from "../audit/audit.module";
import { EmptyInputPipe } from "../users/empty-input.pipe";
import { VERIFICATION_PROVIDER } from "./verification.provider";
import { createVerificationProvider } from "./create-verification-provider";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { VerificationRepository } from "./verification.repository";
import { VerifiedOutcomeService } from "./verified-outcome.service";

// Owns replaceable verification adapters and minimal outcomes; no raw identity vault.
@Module({
  imports: [DatabaseModule, UsersModule, AuditModule], controllers: [VerificationController],
  exports: [VerifiedOutcomeService],
  providers: [VerificationService, VerificationRepository, VerifiedOutcomeService, EmptyInputPipe, {
    provide: VERIFICATION_PROVIDER, inject: [APP_CONFIG],
    useFactory: (config: RuntimeConfig) => createVerificationProvider(config),
  }],
})
export class VerificationModule {}
