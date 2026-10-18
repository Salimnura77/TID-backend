# QoreID Test verification

The implemented provider boundary targets the authorized **NIN with NIN** route.
Test credentials are stored only in ignored local configuration. No invented
identity profiles, application users or production seed data were added.

## Provider setup

The adapter follows QoreID's official [authentication](https://docs.qoreid.com/reference/get-client-token)
and [NIN](https://docs.qoreid.com/reference/nin-identity) contracts:
POST /token with clientId/secret, followed by POST /v1/ng/identities/nin/{idNumber}
with only firstname and lastname. Its official Markdown OpenAPI confirms the
token response fields accessToken, expiresIn and tokenType.

Configure TRUEID_QOREID_MODE=sandbox, TRUEID_QOREID_ROUTE=nin,
TRUEID_QOREID_TEST_CLIENT_ID and TRUEID_QOREID_TEST_CLIENT_SECRET in ignored .env
or secret-manager injection. Blank settings disable submissions; partial settings
fail startup without printing values. Production and QoreID Live/production key
settings are rejected. There is no Live adapter path. [Test and Live share a host](https://docs.qoreid.com/reference/environment),
so opaque credentials must be provisioned as Test keys in the dashboard; a local
label cannot establish a key's type.

Local inputs are restricted to QoreID's [published Test NIN inputs](https://docs.qoreid.com/reference/sample-test-data).
Crossed Test names support its documented negative-match simulation. Optional
attributes and images are not requested. Provider references are omitted until
retention permission is established.

## API and persistence

Both endpoints use the existing default-deny Auth0 guard, account:self scope,
server-resolved active account and Cache-Control: no-store.

- POST /api/v1/verifications accepts exactly nin, firstname and lastname.
  Idempotency-Key must be a random UUIDv4. HTTP 200 returns {verification, created};
  inspect the outcome before treating the result as verified.
- GET /api/v1/verifications/:id returns only the authenticated owner's result.
  Another owner's reference returns 404; account-selection/query inputs are rejected.

Views contain an opaque ID, provider/route/environment codes, outcome/reason and
UTC timestamps. Private account and submission IDs stay in storage. No identity
numbers, names, documents, images, input hashes, provider payloads or tokens are
persisted.

Migration 003 adds constrained attempts and coded audit events. Account/key
uniqueness makes replays return the original result without replacing inputs or
calling QoreID again. A partial unique index permits one in-progress attempt per
account. Short transactions lock the account through the exported Users boundary;
provider calls happen outside transactions. Finalization checks active ownership.
Only one terminal transition is allowed, committed with its audit event.

Stale reservations become timeout after 30 seconds during an account read or
submission. They never cause an automatic retry. New submissions require new keys.

## Outcome and privacy policy

Completed, verified results require an exact match on both required names.
Partial/transposed matches and pending provider results become needs_review;
documented negative matches become unable_to_verify. Unknown, malformed or
contradictory positive responses fail closed. See the provider's [status/summary contract](https://docs.qoreid.com/docs/webhook-payload-structure).
There is no manual override or webhook endpoint.

A five-second deadline covers authentication plus verification, including
replacement adapters. Timeouts/504 become timeout; network/auth/permission/rate-limit
failures become provider_unavailable with fixed reason codes. Redirects are denied,
responses are bounded to 1 MiB and calls are not automatically retried.

Only fixed codes leave the adapter. Exceptions and arbitrary provider fields are
discarded. Operational logs use fixed route labels; audit events contain coded
lifecycle metadata only. No tracing SDK or provider-response capture is configured.
Future instrumentation must exclude this client: its documented URL contains the
identity input. Verification does not authorize partner disclosure or establish
legal KYC compliance.

## Commands, checks and remaining setup

Use the existing PostgreSQL workflow and run npm run db:migrate. Auth0 developer
tenant/Native PKCE configuration remains required for authenticated API access.

npm run check runs tests, typecheck, lint and build. The verification stage passed
54 security/contract tests; the subsequent credential stage reaches 74. Defaults
make no provider calls and use ephemeral technical
principals and isolated PGlite databases; this is not TCP PostgreSQL or production
security evidence.

npm run test:qoreid is separate and skips unless TRUEID_RUN_QOREID_SANDBOX_TESTS=true.
It loads ignored .env and uses published Test inputs without creating accounts,
storing responses or printing secret/token values.

The authorized Test check on 2026-10-13 returned authentication **201** and NIN
**403**: **0 passed, 1 failed, exit 1**. The negative scenario was not reached.
Check this client's Test collection subscription/permission using [collection setup](https://docs.qoreid.com/docs/setting-up-collections)
and [response codes](https://docs.qoreid.com/reference/response-codes). Do not switch
to Live to resolve it. Production needs separate approval, production configuration
and credentials, retention decisions, deployment hardening and integration checks.

## Files changed for verification

- src/verification/: module, controller, DTO, service, repository, provider interface,
  QoreID adapter and sandbox input gate.
- src/users/account-access.service.ts and users.module.ts: narrow transaction boundary.
- src/audit/audit.service.ts and audit.module.ts: coded verification writes.
- migrations/003_verification.sql and src/database/migrations.ts: schema/readiness.
  Existing migrations 001 and 002 remain unchanged.
- src/config/runtime-config.ts and .env.example: optional all-or-none Test configuration.
- src/http/api-error.ts, request-logging.middleware.ts and
  src/logging/structured-logger.ts: safe codes and static route labels.
- tests/qoreid-provider.test.ts, verification.test.ts, qoreid-sandbox.integration.ts
  and migrations.test.ts: security, contract and opt-in integration checks.
- package.json, README.md, docs/modules.md, docs/stages.md and this guide.
  Local .env is ignored and contains Test configuration.

The mobile, website and Figma/Vite projects were not modified. Nothing was deployed
or published.
