import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthenticatedIdentity } from "../auth/identity";
import { DatabaseService } from "../database/database.service";
import { ApiError } from "../http/api-error";
import { AccountAccessService } from "../users/account-access.service";
import { VerifiedOutcomeService } from "../verification/verified-outcome.service";
import { CREDENTIAL_CLOCK, CREDENTIAL_TTL_SECONDS, credentialClaims, credentialStatus, credentialView } from "./credential";
import type { CredentialClock, CredentialRecord } from "./credential";
import { CredentialRepository } from "./credential.repository";
import { credentialKeyId, signCredential, verifyCredentialSignature } from "./credential-jws";
import { SIGNING_KEYS } from "./signing-key";
import type { SigningKeys } from "./signing-key";

@Injectable()
export class CredentialsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountAccessService) private readonly accounts: AccountAccessService,
    @Inject(VerifiedOutcomeService) private readonly outcomes: VerifiedOutcomeService,
    @Inject(CredentialRepository) private readonly repository: CredentialRepository,
    @Inject(SIGNING_KEYS) private readonly keys: SigningKeys,
    @Inject(CREDENTIAL_CLOCK) private readonly clock: CredentialClock,
  ) {}
  private async signing<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(controller.signal), new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ApiError(503, "signing_unavailable")); }, 5000);
      })]);
    } catch { throw new ApiError(503, "signing_unavailable"); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async issue(identity: AuthenticatedIdentity, verificationId: string) {
    if (this.keys.mode !== "test") throw new ApiError(503, "signing_unavailable");
    // Two concurrent issuers may sign plans, but only the winning reference is
    // committed/returned. A loser resumes the immutable stored reference once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.database.transaction(async (client) => {
        const accountId = await this.accounts.requireActive(identity, client);
        await this.outcomes.requireLatestVerified(client, accountId, verificationId);
        return { accountId, record: await this.repository.findVerification(client, accountId, verificationId) };
      });
      if (existing.record && credentialStatus(existing.record, this.clock.now()) !== "active") throw new ApiError(409, "credential_inactive");
      const signed = await this.signing(async (signal) => {
        const key = existing.record ? await this.keys.version(existing.record.signing_key_id) : await this.keys.active();
        const issuedAt = new Date(Math.floor(this.clock.now().getTime() / 1000) * 1000);
        const plan: CredentialRecord = existing.record ?? { id: randomUUID(), account_id: existing.accountId, verification_id: verificationId,
          signing_key_id: key.id, state: "active", issued_at: issuedAt,
          expires_at: new Date(issuedAt.getTime() + CREDENTIAL_TTL_SECONDS * 1000), revoked_at: null };
        return { plan, ...await signCredential(plan, key, signal) };
      });
      const result = await this.database.transaction(async (client) => {
        const accountId = await this.accounts.requireActive(identity, client);
        await this.outcomes.requireLatestVerified(client, accountId, verificationId);
        const now = this.clock.now();
        if (credentialStatus(signed.plan, now) !== "active") throw new ApiError(409, "credential_inactive");
        const result = await this.repository.issue(client, signed.plan, signed.publicKey, now);
        if (credentialStatus(result.record, now) !== "active") throw new ApiError(409, "credential_inactive");
        return result;
      });
      if (result.record.id === signed.plan.id) return { credential: credentialView(result.record, this.clock.now()), signedCredential: signed.token, created: result.created };
    }
    throw new ApiError(503, "signing_unavailable");
  }

  async status(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      return { credential: credentialView(await this.repository.read(client, accountId, id), this.clock.now()) };
    });
  }
  async revoke(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      return { credential: credentialView(await this.repository.revoke(client, accountId, id, this.clock.now()), this.clock.now()) };
    });
  }
  async check(identity: AuthenticatedIdentity, token: string) {
    const keyId = credentialKeyId(token);
    const publicKey = await this.database.withClient((client) => this.repository.publicKey(client, keyId));
    const claims = await verifyCredentialSignature(token, publicKey);
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      const record = await this.repository.read(client, accountId, claims.jti as string);
      const expected = credentialClaims(record);
      if (record.signing_key_id !== keyId || claims.iat !== expected.iat || claims.exp !== expected.exp ||
          (claims.iat as number) > Math.floor(this.clock.now().getTime() / 1000)) throw new ApiError(400, "credential_invalid");
      const credential = credentialView(record, this.clock.now());
      return { credential, valid: credential.status === "active" };
    });
  }
}
