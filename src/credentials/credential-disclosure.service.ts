import { Inject, Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";
import { credentialStatus } from "./credential";
import { CredentialRepository } from "./credential.repository";

// Narrow boundary: no JWT, internal identity, key or verification reference leaves
// Credentials. Caller holds the account lifecycle lock in its transaction.
@Injectable()
export class CredentialDisclosureService {
  constructor(@Inject(CredentialRepository) private readonly repository: CredentialRepository) {}
  async requireActive(client: SqlExecutor, accountId: string, credentialId: string, now: Date) {
    const record = await this.repository.read(client, accountId, credentialId);
    if (record.issued_at > now || credentialStatus(record, now) !== "active") throw new ApiError(403, "credential_inactive");
    return { verification_result: "verified" as const, verification_expires_at: record.expires_at.toISOString() };
  }
}
