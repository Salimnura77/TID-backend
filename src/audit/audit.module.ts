import { Module } from "@nestjs/common";
import { AuditService } from "./audit.service";

// Owns coded domain audit records. Operational HTTP logs belong to LoggingModule.
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
