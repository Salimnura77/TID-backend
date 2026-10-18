import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedIdentity } from "../auth/identity";
import { AuditService } from "../audit/audit.service";
import { CredentialDisclosureService } from "../credentials/credential-disclosure.service";
import { DatabaseService } from "../database/database.service";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";
import { secretDigest } from "../partners/partner-key";
import type { PartnerIdentity } from "../partners/partner-key";
import type { PartnerPermission } from "../partners/partner-permission";
import { PartnersService } from "../partners/partners.service";
import { AccountAccessService } from "../users/account-access.service";
import { canonicalAttributes, CONSENT_CLOCK, consentState, consentView } from "./consent";
import type { ConsentClock, ConsentRecord, ShareableAttribute } from "./consent";
import type { DecisionDto, DisclosureDto, InvitationDto, RequestDto } from "./consent.dto";
import { ConsentRepository } from "./consent.repository";

@Injectable()
export class ConsentService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountAccessService) private readonly accounts: AccountAccessService,
    @Inject(PartnersService) private readonly partners: PartnersService,
    @Inject(CredentialDisclosureService) private readonly credentials: CredentialDisclosureService,
    @Inject(ConsentRepository) private readonly repository: ConsentRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONSENT_CLOCK) private readonly clock: ConsentClock,
  ) {}

  async partner(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      await this.accounts.requireActive(identity, client);
      return { demo: true, partner: await this.partners.requireActive(client, id, false) };
    });
  }
  async invite(identity: AuthenticatedIdentity, input: InvitationDto) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      const partner = await this.partners.requireActive(client, input.partnerId);
      const now = this.clock.now();
      const result = await this.credentials.requireActive(client, accountId, input.credentialId, now);
      const expiresAt = new Date(Math.min(now.getTime() + 300000, Date.parse(result.verification_expires_at)));
      const invitation = randomBytes(32).toString("base64url");
      await this.repository.invite(client, accountId, partner.id, input.credentialId, secretDigest(invitation), now, expiresAt);
      return { demo: true, invitation, partner, expiresAt: expiresAt.toISOString() };
    });
  }
  async request(identity: PartnerIdentity, input: RequestDto) {
    return this.database.transaction(async (client) => {
      const digest = secretDigest(input.invitation);
      const reference = await this.repository.invitation(client, identity.id, digest);
      await this.accounts.requireActiveReference(client, reference.account_id);
      await this.partners.requireAuthenticated(client, identity, "requests:create");
      const invitation = await this.repository.invitation(client, identity.id, digest, true);
      const now = this.clock.now();
      if (invitation.consumed_at || now >= invitation.expires_at) throw new ApiError(409, "invitation_inactive");
      const expiresAt = this.expiry(input.expiresAt, now, invitation.expires_at);
      await this.credentials.requireActive(client, invitation.account_id, invitation.credential_id, now);
      const record = await this.repository.create(client, invitation, input.purpose, canonicalAttributes(input.attributes), expiresAt, now);
      await this.event(client, record, "request_created", identity.credentialId);
      return { demo: true, request: consentView(record, this.clock.now()) };
    });
  }
  async list(identity: AuthenticatedIdentity) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      const records = await this.repository.list(client, accountId);
      return { demo: true, requests: await Promise.all(records.map((record) => this.ownerView(client, record))) };
    });
  }
  async read(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      return { demo: true, request: await this.ownerView(client, await this.repository.read(client, { accountId }, id)) };
    });
  }
  async history(identity: AuthenticatedIdentity, id: string, cursor?: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      await this.repository.read(client, { accountId }, id);
      return { demo: true, ...await this.audit.consentHistory(client, accountId, id, cursor) };
    });
  }
  async decide(identity: AuthenticatedIdentity, id: string, input: DecisionDto) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      const record = await this.repository.read(client, { accountId }, id, true);
      const now = this.clock.now();
      const state = consentState(record, now);
      if (record.revision !== input.revision || (state !== "pending" && state !== "approved")) throw new ApiError(409, "consent_conflict");
      let attributes: ShareableAttribute[] | null = null;
      let expiry: Date | null = null;
      if (input.decision === "approve") {
        if (!Array.isArray(input.attributes) || !input.attributes.length || typeof input.expiresAt !== "string" ||
          input.attributes.some((field) => !record.requested_attributes.includes(field))) throw new ApiError(400, "invalid_request");
        await this.partners.requireActive(client, record.partner_id);
        await this.credentials.requireActive(client, accountId, record.credential_id, this.clock.now());
        if (consentState(record, this.clock.now()) !== state) throw new ApiError(409, "consent_conflict");
        attributes = canonicalAttributes(input.attributes);
        expiry = this.expiry(input.expiresAt, this.clock.now(), record.expires_at);
      } else if (state !== "pending" || input.attributes !== undefined || input.expiresAt !== undefined) {
        throw new ApiError(400, "invalid_request");
      }
      const changed = await this.repository.decide(client, record, input.decision === "approve" ? "approved" : "declined", attributes, expiry, this.clock.now());
      await this.event(client, changed, input.decision === "approve" ? "consent_approved" : "consent_declined");
      return { demo: true, request: await this.ownerView(client, changed) };
    });
  }
  async revoke(identity: AuthenticatedIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const accountId = await this.accounts.requireActive(identity, client);
      let record = await this.repository.read(client, { accountId }, id, true);
      if (record.state === "pending") throw new ApiError(409, "consent_conflict");
      if (record.state === "approved") {
        record = await this.repository.revoke(client, record, this.clock.now());
        await this.event(client, record, "consent_revoked");
      }
      return { demo: true, request: await this.ownerView(client, record) };
    });
  }
  async partnerRead(identity: PartnerIdentity, id: string) {
    return this.database.transaction(async (client) => {
      const record = await this.partnerRecord(client, identity, id, "requests:read");
      return { demo: true, request: consentView(record, this.clock.now()) };
    });
  }
  async disclose(identity: PartnerIdentity, id: string, input: DisclosureDto) {
    return this.database.transaction(async (client) => {
      const record = await this.partnerRecord(client, identity, id, "disclosures:create");
      // Exact current context, rather than caller-selected purpose or an old scope.
      if (!this.matches(record, input)) throw new ApiError(403, "disclosure_denied");
      const source = await this.credentials.requireActive(client, record.account_id, record.credential_id, this.clock.now());
      const pairwiseId = await this.partners.pairwiseIdentifier(client, record.account_id, identity.id);
      await this.event(client, record, "attributes_disclosed", identity.credentialId);
      // Recheck wall time after awaited database operations, at the disclosure
      // linearization point. A rollback also removes the audit/pairwise insert.
      if (!this.matches(record, input) || this.clock.now() >= new Date(source.verification_expires_at)) throw new ApiError(403, "disclosure_denied");
      const attributes: Partial<typeof source> = {};
      for (const field of record.approved_attributes!) Object.assign(attributes, { [field]: source[field] });
      return { demo: true, disclosure: { pairwiseId, purpose: record.purpose,
        expiresAt: record.approved_expires_at!.toISOString(), attributes, test: true } };
    });
  }
  private matches(record: ConsentRecord, input: DisclosureDto): boolean {
    return consentState(record, this.clock.now()) === "approved" && record.revision === input.revision && record.purpose === input.purpose &&
      record.approved_expires_at?.toISOString() === input.expiresAt &&
      JSON.stringify(record.approved_attributes) === JSON.stringify(canonicalAttributes(input.attributes));
  }
  private async partnerRecord(client: SqlExecutor, identity: PartnerIdentity, id: string, permission: PartnerPermission) {
    const reference = await this.repository.read(client, { partnerId: identity.id }, id);
    await this.accounts.requireActiveReference(client, reference.account_id);
    await this.partners.requireAuthenticated(client, identity, permission);
    return this.repository.read(client, { partnerId: identity.id }, id, true);
  }
  private expiry(value: string, now: Date, maximum: Date): Date {
    const expiry = new Date(value);
    if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== value || expiry <= now || expiry > maximum) throw new ApiError(400, "invalid_request");
    return expiry;
  }
  private async ownerView(client: SqlExecutor, record: ConsentRecord) {
    return { ...consentView(record, this.clock.now()), partner: await this.partners.describe(client, record.partner_id), credentialId: record.credential_id };
  }
  private event(client: SqlExecutor, record: ConsentRecord, event: Parameters<AuditService["consentState"]>[5], partnerCredentialId?: string) {
    return this.audit.consentState(client, record.account_id, record.partner_id, record.id, record.revision, event, partnerCredentialId);
  }
}
