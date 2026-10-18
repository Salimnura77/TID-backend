import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedIdentity } from "../auth/identity";
import { DatabaseService } from "../database/database.service";
import { ApiError } from "../http/api-error";
import { AccountAccessService } from "../users/account-access.service";
import { VerificationRepository } from "./verification.repository";
import { VERIFICATION_PROVIDER, safeResult } from "./verification.provider";
import type { VerificationInput, VerificationProvider, VerificationResult } from "./verification.provider";
import { isSandboxInput } from "./sandbox-input";

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountAccessService) private readonly accounts: AccountAccessService,
    @Inject(VerificationRepository) private readonly repository: VerificationRepository,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider,
  ) {}

  private async verify(input: VerificationInput): Promise<VerificationResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<VerificationResult>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ outcome: "timeout", reason: "provider_timeout" }); }, 5000);
      });
      // Replacement adapters also have a deadline. Late/rejected responses never
      // update state independently or escape as raw upstream exceptions.
      return safeResult(await Promise.race([this.provider.verify(input, controller.signal), deadline]));
    } catch {
      return controller.signal.aborted ? { outcome: "timeout", reason: "provider_timeout" } : { outcome: "provider_unavailable", reason: "provider_unavailable" };
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async submit(identity: AuthenticatedIdentity, submissionKey: string, input: VerificationInput) {
    if (!this.provider.available) throw new ApiError(503, "verification_unavailable");
    if (!isSandboxInput(input)) throw new ApiError(400, "sandbox_input_required");
    const claim = await this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      return this.repository.claim(client, accountId, submissionKey);
    });
    if (!claim.claimed) return { verification: claim.attempt, created: false };
    const result = await this.verify(input);
    const verification = await this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      return this.repository.complete(client, accountId, claim.attempt.id, result);
    });
    return { verification, created: true };
  }

  async read(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      await this.repository.expireStale(client, accountId);
      return { verification: await this.repository.read(client, accountId, id) };
    });
  }
}
