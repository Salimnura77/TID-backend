import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CredentialsModule } from "../credentials/credentials.module";
import { DatabaseModule } from "../database/database.module";
import { PartnersModule } from "../partners/partners.module";
import { UsersModule } from "../users/users.module";
import { EmptyInputPipe } from "../users/empty-input.pipe";
import { CONSENT_CLOCK } from "./consent";
import { ConsentRepository } from "./consent.repository";
import { ConsentService } from "./consent.service";
import { ConsentController, PartnerRequestsController } from "./consent.controller";

// Owns requests, explicit decisions, scoped history and the server disclosure boundary.
@Module({ imports: [DatabaseModule, UsersModule, PartnersModule, CredentialsModule, AuditModule],
  controllers: [ConsentController, PartnerRequestsController],
  providers: [ConsentRepository, ConsentService, EmptyInputPipe, { provide: CONSENT_CLOCK, useValue: { now: () => new Date() } }],
})
export class ConsentModule {}
