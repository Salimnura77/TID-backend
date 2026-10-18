import { Module } from "@nestjs/common";
import { RuntimeConfigModule } from "./config/runtime-config.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { VerificationModule } from "./verification/verification.module";
import { CredentialsModule } from "./credentials/credentials.module";
import { PartnersModule } from "./partners/partners.module";
import { ConsentModule } from "./consent/consent.module";
import { AuditModule } from "./audit/audit.module";
import { LoggingModule } from "./logging/logging.module";

@Module({ imports: [
  RuntimeConfigModule, LoggingModule, HealthModule,
  AuthModule, UsersModule, VerificationModule, CredentialsModule, PartnersModule, ConsentModule, AuditModule,
] })
export class AppModule {}
