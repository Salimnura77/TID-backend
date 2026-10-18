# Partner requests and explicit user consent

This slice implements registered partners, user-routed requests, explicit
approve/decline, approval amendments, consent review, revocation and online
disclosure. It shares **Test verification metadata only**, never NIN/BVN, names,
documents, signed credentials or a universal account/credential/verification ID.
It does not establish a partner's legal KYC compliance.
The subsequent [pilot authentication/history stage](pilot-partner-audit.md) adds
credential rotation/revocation, endpoint permissions and owner-scoped audit pages.

## Smallest design and authentication

Mobile authentication keeps the existing Auth0 developer-tenant Authorization Code
+ PKCE contract. Every user action requires `account:self` and an active account.
Partners have a separate opaque API key: random client UUID plus 256 random secret
bits. Only a SHA-256 digest is stored in PostgreSQL. The guard parses this credential separately
from mobile JWTs and compares fixed-length digests using `timingSafeEqual`.
Mobile tokens cannot call partner routes; partner keys cannot call user routes.
No public registration endpoint, seed client or extra identity provider is added.

An operator registers each actual local pilot partner by name. The user sees this
server-owned name when reviewing consent. The smallest routing mechanism is an
authenticated user-created, partner-specific, single-use invitation. It binds an
owned active credential to the partner, without sending an account ID. Creating
an invitation **does not approve disclosure**. The partner must subsequently make
a request and the user must explicitly decide it. Invitation delivery is outside
this API: keep it in a request body/in-memory handoff, never a logged URL.

`PartnersModule` owns client authentication and immutable random pairwise mappings.
`ConsentModule` owns invitations, immutable request scope and versioned decisions.
It consumes the exported active-account and minimal credential-disclosure services;
it never queries their tables or imports their private repositories.
`AuditModule` writes fixed event/reference/revision metadata in the same transaction.

## Setup and commands

No new environment variables or dependencies are required. Preserve the existing
ignored `.env`/`.env.test` settings. A migrated local PostgreSQL database, configured
Auth0 sandbox, authorized provider Test outcome and active dedicated Test credential
are needed to exercise the whole flow. Signing remains enabled only by the
existing explicit Test configuration. Production mode is still rejected.

```powershell
npm run db:migrate
npm run partners:register -- "Actual pilot partner name"
# Register prints public partnerId/credentialId references only. The generated key is written once to:
# partner-keys/<partnerId>.<credentialId>.json (ignored, exclusive creation, requested mode 0600).
# Configure that key in the partner's SERVER-side secrets, never the mobile app.
npm run build
npm run start:test
# To disable a registered client permanently:
npm run partners:disable -- <partnerId>

# Full available checks:
npm run check
# Equivalent individual checks:
npm test
npm run typecheck
npm run lint
npm run build
```

The provisioning command uses `.env` for the dedicated local database and checks
schema readiness. It is not a runtime seed and was not run to create application
partners during implementation. Protect the ignored key directory using local
Windows ACLs; the POSIX mode request alone does not set Windows ACLs. A failed
database commit may leave an unused key file; an unregistered key cannot authenticate.
Use the [pilot lifecycle commands](pilot-partner-audit.md) to inspect credential
references, rotate/revoke a key or disable the client. After secure delivery to the
partner server's secret store, remove the local plaintext handoff copy. This is
an operator-only local pilot flow, not a production OAuth client-management service.

## API contract

All routes use `/api/v1`, reject unknown fields and nonempty query strings (except
the history route's scoped `cursor`), and
return `Cache-Control: no-store`. UTC instants use canonical ISO format
`YYYY-MM-DDTHH:mm:ss.sssZ`. UUIDs supplied as references must be UUIDv4.

User routes require `Authorization: Bearer <Auth0 access token>`:

| Method | Route | Input / behavior |
| --- | --- | --- |
| GET | `/consent/partners/:id` | Active registered partner's public ID and display name |
| POST | `/consent/invitations` | `{ partnerId, credentialId }`; returns one-time `invitation`, partner and expiry; no consent implied |
| GET | `/consent/requests` | Owner's latest 100 requests, partner name, state and approval metadata; no disclosed values |
| GET | `/consent/requests/:id` | Owner's request and decision context; includes the owner's bound credential reference |
| GET | `/consent/requests/:id/history` | Owner's coded event history, up to 50 per page with optional scoped event cursor |
| POST | `/consent/requests/:id/decision` | `{ decision: "approve", revision, attributes, expiresAt }` or `{ decision: "decline", revision }` |
| POST | `/consent/requests/:id/revoke` | Empty body; terminal idempotent withdrawal of an approved grant |

Partner routes require `Authorization: Bearer <registered partner API key>`:

| Method | Route | Input / behavior |
| --- | --- | --- |
| POST | `/partner/requests` | `{ invitation, purpose, attributes, expiresAt }`; authenticated partner is derived from its key, never caller-selected |
| GET | `/partner/requests/:id` | That partner's scope, state, revision and approval metadata only; no values or user/credential IDs |
| POST | `/partner/requests/:id/disclosure` | `{ purpose, attributes, expiresAt, revision }` must exactly match current approval; returns only approved values and the pairwise ID |

`purpose` is explicit, 1–200 characters, without control characters or surrounding
whitespace. Attribute lists are unique, nonempty, exact sets. This backend stores
no verified name, age or nationality, so its only allowed attributes are:

| Attribute | Approved value |
| --- | --- |
| `verification_result` | `"verified"`, from the active Test credential |
| `verification_expires_at` | That credential's UTC expiry |

An approval may select only a subset of the requested set and an expiry no later
than the request. An explicit later amendment may change that subset/expiry only
within the original request, while the grant and credential remain active. Each
decision increments `revision`; the UI must submit the revision it reviewed.
After any amendment the partner must obtain the current metadata; an old context
is denied. Repeating a GET never approves or discloses anything.

Example: if both fields were requested and only `verification_result` was approved,
the partner supplies exactly that field, purpose, approved expiry and revision.
The response is:

```json
{
  "demo": true,
  "disclosure": {
    "pairwiseId": "<random UUID unique to this user and partner>",
    "purpose": "<approved purpose>",
    "expiresAt": "<approved UTC expiry>",
    "attributes": { "verification_result": "verified" },
    "test": true
  }
}
```

No extra identity field is synthesized. Errors have the existing fixed coded
envelope, without a `disclosure`, `attributes` or pairwise identifier. A wrong
partner gets 404; mismatched, pending, declined, expired or revoked consent gets
403; a stale/terminal decision gets 409. An inactive credential blocks disclosure.
The pairwise UUID is stored once for an account/partner pair, globally unique and
immutable; it remains stable across requests and new credential issuance.

## State and transactional guarantees

Requests begin `pending`. A reviewed revision can become `approved` or `declined`.
An active approval can be explicitly amended or `revoked`. Decline and revocation
are terminal. Expiry is checked at the exact UTC instant without a background job;
pending requests and grants cannot be renewed after expiry. Requests and invitations
cannot exceed the bound credential's five-minute Test lifetime. Reverification
never transfers a grant to the replacement credential; a fresh request and approval
are necessary. Credential revocation/supersession blocks all future disclosures
against that reference even if the consent metadata still says approved.

Every partner disclosure uses a short transaction: resolve a partner-scoped
server-owned reference; lock/check the active account; lock/recheck partner key and
status plus current credential revocation/endpoint permissions; lock/check the current consent; obtain only active credential metadata;
resolve the pairwise ID; append a coded audit event; recheck expiry before commit.
User decisions, revocation, credential issuance/revocation and partner disabling
use compatible lifecycle locks. A completed revocation/amendment/disable is
effective on subsequent reads. An already authorized in-flight response may finish
before a waiting revocation commits. Previously received values cannot be recalled.
Operational logs omit keys, tokens, invitations, purpose text, raw inputs, disclosed
values, pairwise IDs and parameter values. Audit records contain only coded event,
account/partner/request references, revision and timestamp, with no purpose or values.
New partner actions also record a scoped authenticating credential reference;
the subsequent history API omits that implementation reference from user responses.

Migration `005_partner_consent.sql` adds clients, immutable pairwise mappings,
hashed single-use invitations, immutable request scope, lifecycle constraints and
append-only consent audit rows. Database foreign keys enforce account/credential/
partner bindings. Audit failure rolls back a decision/disclosure. No prior migration
was edited. The migration runner and readiness check include the new tables.

The separate Expo/Next.js/Figma projects remain unchanged. The existing fictional
mobile adapter has its own attribute names, millisecond timestamps and per-use
presentation interaction. This new API needs an explicit Auth0/mobile adapter;
it does not silently replace that contract. This slice implements repeat online
reads during a current explicit grant, as requested; it adds no offline or cached
partner disclosure capability. A future per-use presentation flow is separate work.

## Validation and remaining setup

The starting baseline was 74 passing tests with typecheck, lint and build passing.
The added tests exercise real Nest HTTP authentication/DTO boundaries and isolated
PostgreSQL-engine state, using ephemeral technical principals, dedicated Test keys
and provider-interface test doubles. They create no runtime seeds or human identity
profiles and make no external provider calls.

Historical consent-stage results on 2026-10-14 (latest checks are in the pilot authentication/history guide):

| Command/check | Exact result |
| --- | --- |
| `npm run check` | Exit 0; all four sequential checks passed |
| `npm test` (within check) | 93 passed, 0 failed, 0 cancelled, 0 skipped; 56,869.5664 ms |
| `npm run typecheck` (within check) | Passed, exit 0 |
| `npm run lint` (within check) | Passed, exit 0, zero warnings |
| `npm run build` (within check) | Passed, exit 0 |
| Focused consent/migration run before final timing additions | `node --test dist-test/tests/consent.test.js dist-test/tests/migrations.test.js`: exit 0; 21 passed, 0 failed, 0 skipped |
| Provisioning CLI production/invalid-command smoke | Both child commands returned expected exit 1 and fixed `partner_setup_failed` only; no key artifacts changed; assertion script exit 0 |
| Source/private-material isolation scan | Exit 0; 105 files scanned, zero configured-provider-credential/private-key findings outside ignored configuration/key directories |

Migration tests applied all five migrations and checked repeatability, checksums,
rollback and database constraints using PGlite. Neither a TCP PostgreSQL migration
nor concurrent TCP clients were exercised. PGlite serializes transactions; its
competing-request tests exercise API state/revision policy, not PostgreSQL pool
contention or distributed timing. The separate Auth0/QoreID external integration
commands were not run for this slice. No runtime partner or account was seeded.

Changed files in this slice:

- `src/partners/`: authentication, key helpers, provisioning/disabling and pairwise
  persistence service; `src/consent/`: DTOs, state helpers, repository, service,
  user/partner controllers and module wiring.
- `src/auth/auth.guard.ts`, `auth.module.ts`: explicit partner principal handling
  in the existing default-deny guard.
- `src/users/account-access.service.ts`: lifecycle locking for server-owned
  account references; `src/credentials/credential-disclosure.service.ts` and
  `credentials.module.ts`: narrow active credential metadata boundary.
- `src/audit/audit.service.ts`, `src/database/migrations.ts`,
  `migrations/005_partner_consent.sql`: atomic coded audit writes, readiness and
  new constrained storage, without changing applied migrations.
- `src/http/api-error.ts`, `request-logging.middleware.ts`,
  `src/logging/structured-logger.ts`: fixed safe errors and static route labels.
- `scripts/partner-client.ts`, `package.json`, `.gitignore`: operator commands and
  ignored local key artifacts. No dependency or lockfile change was needed.
- `tests/consent.test.ts`, `tests/migrations.test.ts`: authorization, state, timing,
  privacy, pairwise and migration coverage.
- `README.md`, `docs/modules.md`, `docs/stages.md`, `docs/credentials.md` and this
  guide: current behavior, boundaries, setup, commands and limitations.

External integration still requires a running TCP PostgreSQL database and migration
005, named pilot partner registration and server-side key configuration, Auth0/PKCE
mobile wiring, and resolution of the previously observed QoreID Test NIN 403
permission denial. That provider integration was not retried or switched to Live.
Production KMS/HSM, production credential/auth/client management, TLS, database
privileges, rate limits, retention and operational review remain deployment work.
No deployment, publishing, production keys, payment, wallet or USSD feature is added.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html),
[Nest guards](https://docs.nestjs.com/guards),
[PostgreSQL row locks](https://www.postgresql.org/docs/17/explicit-locking.html).
