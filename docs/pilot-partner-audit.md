# Pilot partner authentication and consent history

This stage extends the existing partner/consent slice. It adds credential lifecycle
and endpoint permissions for the single operator-managed pilot partner, plus the
minimum owner-visible consent history. There is no public partner onboarding,
HTTP credential-management API, new provider integration or deployment.

## Authentication and permissions

The existing server-to-server `Authorization: Bearer <partner API key>` format is
preserved: a public partner UUID plus 256 random secret bits. PostgreSQL stores
only a SHA-256 digest of that API key. Plaintext keys, digests, tokens and provider
secrets never enter audit events, operational logs or HTTP errors. Auth0 mobile
tokens and partner credentials remain separate principal types.

Migration 006 moves key hashes from `partner_clients` into
`partner_api_credentials`. The partner ID stays stable while credential IDs change
on rotation. Each credential belongs to exactly one partner and has an explicit,
immutable set of these permissions:

| Permission | Endpoint |
| --- | --- |
| `requests:create` | `POST /api/v1/partner/requests` |
| `requests:read` | `GET /api/v1/partner/requests/:id` |
| `disclosures:create` | `POST /api/v1/partner/requests/:id/disclosure` |

The pilot's default credential has these three permissions, the minimum needed to
complete the existing flow. No permission grants user decisions, user history,
account access, verification, credential issuance, onboarding or key administration.
Partner controllers are closed unless each method declares an allowed permission.
Both the global guard and the transaction doing the actual operation check the
current partner, credential, revocation state and required permission. Caller-supplied
partner or account IDs cannot change ownership.

An operator can narrow permissions through the typed lifecycle helper; rotation
inherits the previous permissions by default and rejects widening. There is at
most one non-revoked credential per partner, enforced by a partial unique index.
Credentials cannot be reassigned, edited, deleted or reactivated after revocation.

## Operator commands and key handling

Use the existing local database configuration; no new environment variables,
dependencies or provider credentials are needed. Production mode remains disabled.
Migrate the dedicated local PostgreSQL database explicitly before operating keys:

```powershell
npm run db:migrate
# Only if the real pilot partner has not been registered:
npm run partners:register -- "Actual pilot partner name"
# Inspect up to 100 credential references, permissions and lifecycle timestamps;
# this prints neither secrets nor hashes and works for migrated legacy clients:
npm run partners:keys -- <partnerId>
# Replace the expected credential and revoke the old key atomically:
npm run partners:rotate -- <partnerId> <credentialId>
# Revoke that exact credential, without disabling the partner identity:
npm run partners:revoke-key -- <partnerId> <credentialId>
# Permanently disable the partner and revoke any remaining active credential:
npm run partners:disable -- <partnerId>
```

Registration/rotation print public partner/credential references only. They retain
the existing local provisioning pattern: one exclusively created, ignored handoff
file `partner-keys/<partnerId>.<credentialId>.json` contains the generated key for
configuration in the **partner's server-side secret store**. This is a plaintext
operator handoff artifact, not an application key store: runtime authentication
never reads it. Keep it out of logs/mobile code/source control, restrict local
Windows ACLs, and remove the handoff copy after secure delivery. The database
retains only the digest. No actual key was generated or handed off in this stage.
The POSIX `0600` mode request does not itself establish Windows ACLs.

Rotation is a hard cutover with no overlap: after the transaction commits, the
previous key fails, and the new key uses the same partner identity, requests,
consents and pairwise mapping. Use the expected credential reference to reject a
stale rotation. If the credential was revoked and no other key is active, the same
command creates a fresh credential/secret; it never restores the old key. A disabled
partner cannot rotate. Revoking the same key again is idempotent, including when
that key was already replaced; it does not affect a newer key.

Credential creation, replacement and revocation write coded audit events in the
same transaction. A failed audit or file write rolls back the key changes. A failed
commit can leave an unused handoff file, which cannot authenticate without a
matching active database credential. Rotation does not move or reactivate consent.
Any revoked/expired/declined grant remains unusable with the replacement key.

## Minimum history API

`GET /api/v1/consent/requests/:id/history` requires the owning active user's Auth0
access token. Other users receive 404; anonymous callers and partner keys cannot
read history. Optional query `cursor=<event UUIDv4>` is the only accepted query
field. A cursor must belong to that same account and request; unknown/mismatched
cursors get fixed `invalid_request` responses.

The response uses `Cache-Control: no-store` and the existing `demo: true` envelope:

```json
{
  "demo": true,
  "events": [
    {
      "id": "<event UUID>",
      "requestId": "<owned request UUID>",
      "partnerId": "<partner UUID>",
      "event": "consent_revoked",
      "actor": "user",
      "revision": 2,
      "occurredAt": "<UTC ISO timestamp>"
    }
  ],
  "nextCursor": null
}
```

Events are newest first, up to 50 per page. Follow `nextCursor` until null. SQL
compares the cursor event's full database timestamp and UUID, so multiple events
within one displayed millisecond are not skipped. History includes
`request_created`, `consent_approved` (including explicit amendments),
`consent_declined`, `attributes_disclosed` and `consent_revoked`. The existing
transactional writes remain the event source; reading history creates no event
and never discloses approved attribute values. Expiry is an evaluated state, not
a fabricated historical action. Failed/denied actions do not produce successful
disclosure events; their operational error records retain only fixed codes.

Stored consent events contain UTC timestamps, internal account/partner/request
references, decision revision and, for new partner actions, the authenticating
partner credential reference. A scoped foreign key prevents a credential from
another partner being recorded as the actor. User actions have no partner
credential reference. Public history omits account IDs, credential IDs, key hashes,
purpose text, attribute names/values, identity inputs, JWTs and provider payloads.

Operator credential events live in `partner_credential_audit_events`, containing
only codes, references and UTC timestamps, with no user-facing administration API.
Audit tables are append-only through database triggers in this local model; this
does not establish tamper-proof storage against a database administrator.

## Migration and boundaries

`006_partner_credentials_audit.sql` preserves the existing key hashes and marks
disabled clients' credentials revoked. Existing pairwise mappings, requests and
consents are unchanged. Backfilled credential events say `credential_migrated`
at migration time; they do not invent historical key creation actions. Historical
consent events keep a null credential reference because the previous stage did
not record that value. New partner events require a reference.

Partners owns credentials and lifecycle operations; its operator helpers use
Audit's fixed event function. Audit owns event storage and scoped page reads.
Consent authorizes ownership before calling the history boundary and passes its
existing transaction to Audit. Auth chooses the explicit endpoint permission;
Consent rechecks it inside the transaction. No module queries another domain's
private tables outside these boundaries. The operator CLI is the only lifecycle
entry point and never creates a partner at app startup.

## Checks and remaining integration

The inspected baseline passed 93 tests plus typecheck, lint and build. Focused
consent/migration tests passed 31 tests before the final operator metadata addition.
Final results on 2026-10-14:

| Command/check | Exact result |
| --- | --- |
| `npm run check` | Exit 0; all four sequential checks passed |
| `npm test` (within check) | 100 passed, 0 failed, 0 cancelled, 0 skipped; 54,210.4912 ms |
| `npm run typecheck` (within check) | Passed, exit 0 |
| `npm run lint` (within check) | Passed, exit 0, zero warnings |
| `npm run build` (within check) | Passed, exit 0 |
| `node --test dist-test/tests/consent.test.js dist-test/tests/migrations.test.js` | Focused run: exit 0; 31 passed, 0 failed, 0 skipped |
| Operator CLI rejection smoke | Seven production/invalid-command cases returned expected child exit 1, empty stdout and fixed `partner_setup_failed` only; assertion script exit 0; key artifacts unchanged |
| Source/private-material isolation scan | Exit 0; 110 files scanned, zero configured-provider-credential/private-key findings outside ignored configuration/key directories |

The first intermediate test compilation found a TypeScript inferred UUID parameter
type mismatch; the key helper now explicitly accepts a validated string. All final
checks above ran after that correction and the final operator metadata changes.

Changed files:

- `migrations/006_partner_credentials_audit.sql`: compatibility migration,
  credential constraints, scoped audit actor references and history index.
- `src/partners/partner-permission.ts` (new), `partner-key.ts`,
  `partner-route.decorator.ts`, `partners.service.ts`, `provision-partner.ts`:
  explicit permissions, credential-specific authentication, operator lifecycle and
  metadata-only key inspection.
- `src/auth/auth.guard.ts`: endpoint permission checks and deny-by-default partner
  controller marker.
- `src/audit/consent-history.dto.ts` and `partner-credential-event.ts` (new),
  `audit.service.ts`: fixed event writes and owner/request-scoped pagination.
- `src/consent/consent.service.ts`, `consent.controller.ts`, `consent.module.ts`:
  transactional reauthorization, partner credential audit references and owner history.
- `src/database/migrations.ts`, `src/http/request-logging.middleware.ts`,
  `src/logging/structured-logger.ts`: readiness and a static redacted history label.
- `scripts/partner-client.ts`, `package.json`: inspect/rotate/revoke CLI commands.
- `tests/consent.test.ts`, `tests/migrations.test.ts`: permission, isolation,
  lifecycle, audit redaction/rollback, history and migration tests.
- `README.md`, `docs/modules.md`, `docs/stages.md`, `docs/partner-consent.md` and
  this guide: current setup, APIs, boundaries, results and limitations.

No dependencies, lockfile, ignored environment values or sibling frontend projects
were changed. No runtime partner/account was provisioned, and no production data,
signing keys, cloud backup or deployment was added.

Remaining setup is the dedicated TCP PostgreSQL database and migration 006, actual
pilot partner server secret delivery, Auth0 developer-tenant/mobile PKCE wiring,
and the previously identified QoreID Test NIN 403 subscription/permission issue.
No provider calls, Live-mode changes or production keys are added. Tests use
ephemeral technical principals, generated Test keys and isolated PGlite databases;
they are not runtime seeds or real identity profiles. PGlite serializes transactions,
so real pooled TCP lock contention remains an integration check. Production TLS,
secret delivery, access privileges, rate limits, retention and managed KMS/HSM
deployment remain external work; local checks imply no regulatory compliance.

References: [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
[Nest authorization](https://docs.nestjs.com/security/authorization),
[PostgreSQL locking](https://www.postgresql.org/docs/17/explicit-locking.html).
