import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { DatabaseModule } from "../database/database.module";
import { UsersModule } from "../users/users.module";
import { VerificationModule } from "../verification/verification.module";
import { AuditModule } from "../audit/audit.module";
import { EmptyInputPipe } from "../users/empty-input.pipe";
import { SIGNING_KEYS } from "./signing-key";
import { TestSigningKeys } from "./test-signing-keys";
import { CREDENTIAL_CLOCK } from "./credential";
import { CredentialRepository } from "./credential.repository";
import { CredentialsService } from "./credentials.service";
import { CredentialsController } from "./credentials.controller";
import { CredentialDisclosureService } from "./credential-disclosure.service";

// Owns credential references, signing adapters and revocation status, not consent decisions.
@Module({
  imports: [DatabaseModule, UsersModule, VerificationModule, AuditModule], controllers: [CredentialsController],
  providers: [CredentialRepository, CredentialsService, CredentialDisclosureService, EmptyInputPipe,
    { provide: CREDENTIAL_CLOCK, useValue: { now: () => new Date() } },
    { provide: SIGNING_KEYS, inject: [APP_CONFIG], useFactory: (config: RuntimeConfig) => new TestSigningKeys(config) },
  ],
  exports: [CredentialDisclosureService],
})
export class CredentialsModule {}
