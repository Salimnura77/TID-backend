# TrueID backend

Separate NestJS + TypeScript modular monolith for the consent-first identity pilot.
**The foundation, authenticated accounts, QoreID Test verification, Test credentials, partner requests and user consent are implemented. The full MVP is not implemented yet.**
Auth0 developer-tenant access tokens can create/resume and read the caller's own account.
Credentials have owner-scoped issuance, validation, status and revocation. Registered
partners receive only explicitly approved verification metadata through current
online consent checks, with a distinct stable pairwise user identifier per partner.
Pilot partner credentials support endpoint permissions, rotation and revocation;
users can read their own coded consent audit history.
QoreID uses configured Test keys and published Test inputs. No email/SMS,
direct government integration or production KYC claims are added.
Monnify NIN/BVN contracts are prepared offline; its runtime adapter remains
unavailable because no approved identity-verification test facility is configured.

## Projects and inspection

The supplied `TID backend` directory was empty: no Git repository, package manifest,
instructions or tests. Before writing files, the sibling `../TID app` projects were
inspected read-only:

- Next.js website at the sibling root: informational pre-launch pages; npm scripts.
- Expo mobile application at `../TID app/mobile`: npm lockfile, domain models,
  service contracts, validators, tests and `AGENTS.md`.
- Existing Node/SQLite fictional pilot at `../TID app/mobile/backend`: pairing,
  server consent, presentation and revocation contracts, tests and documentation.
- Figma/Vite reference at `../TID app/TrueIDDigitalIdentityApp`: separate manifest,
  project instructions, npm and pnpm lockfiles.

Those projects have not been moved, overwritten or made dependencies of this service.
The existing backend remains at this workspace's root; a second `backend/` service
would duplicate it. This backend uses its own npm manifest and lockfile. It uses port **4200** so the
existing fictional pilot can continue on **4100**. See
[the contract map](docs/mobile-contract.md), [the staged plan](docs/stages.md), and
[the module boundaries](docs/modules.md). Current account setup and testing are in
[the account/auth guide](docs/account-auth.md). The historical
[foundation report](docs/foundation-report.md) records the earlier baseline checks.
See [the account/auth change report](docs/account-auth-report.md) for current files,
check results and remaining external setup.

The [QoreID verification guide](docs/qoreid-verification-plan.md) records the
implementation, changed files and Test collection permission still needed.
The [Monnify preparation guide](docs/monnify-preparation.md) documents disabled-only
selection, offline NIN/BVN contract tests and the external activation requirements.
The [credential guide](docs/credentials.md) records minimal claims, dedicated Test
keys, rotation, revocation and the managed production signing boundary.
The [partner/consent guide](docs/partner-consent.md) documents client provisioning,
single-use routing invitations, explicit decisions, amendments, revocation and disclosure.
The [pilot authentication/audit guide](docs/pilot-partner-audit.md) covers scoped
credentials, lifecycle commands, migration compatibility and paginated consent history.
The [CI/CD and external setup guide](docs/ci-cd.md) covers GitHub checks, TCP
PostgreSQL tests, container packaging and disabled-by-default manual image delivery.
Application hosting is not configured yet.

## Smallest module structure

```text
src/
  app.module.ts       Composition root
  auth/              Auth0 verifier and default-deny global guard
  users/             Self-service account routes and scoped repository
  verification/      Verification provider/outcome boundary
  credentials/       Test issuance, validation, status, revocation and signing boundary
  partners/          Partner client/pairwise identifier boundary
  consent/           Request/decision/disclosure boundary
  audit/             Coded verification, credential and consent events
  health/            Public readiness and liveness
  config/            Validated immutable configuration
  database/          PostgreSQL pool and existing migrations
  http/              Versioning, validation, errors and request middleware
  logging/           JSON operational logs and request context
```

Auth, Users, Verification, Credentials, Partners and Consent implement the current
slices; Audit writes their coded lifecycle metadata. Auth0 mobile integration and
provider permissions remain external setup.
No custom password system, seeded users or invented identity profiles are added.

## Local setup

Use Node.js **22.13+ on the 22.x line, or 24+**, and npm 11.4.2.
Run commands from this directory. No local secrets are committed.

```powershell
npm ci
# Only if .env does not exist; preserve configured Test secrets:
Copy-Item .env.example .env
# With Docker installed, start only the local PostgreSQL database:
docker compose up -d postgres
npm run db:migrate
npm start
```

Alternatively, run a local PostgreSQL 17+ instance, create an empty dedicated
`trueid` database and set its loopback URL in `.env`. Do not point migrations at
another project's database. The Compose credentials are clearly labelled test
credentials. Compose persists metadata in a dedicated volume and does not delete it.

`NODE_ENV` accepts only `development` or `test`. Production mode, remote databases,
database URL options and nonlocal browser origins are rejected in Stage 1.
The HTTP listener is `127.0.0.1`; this service does not yet support phone/LAN pairing.
The separate mobile app still needs Auth0 PKCE wiring before using these account routes.

`npm run dev` builds once and watches compiled JavaScript. Run `npm run build:watch`
in another terminal to recompile TypeScript edits automatically.

## Environment variables

| Variable | Default | Validation/meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | Only `development` and `test` in this local foundation |
| `TRUEID_PORT` | `4200` | Integer 1–65535; HTTP host is fixed to `127.0.0.1` |
| `DATABASE_URL` | Required | `postgres:`/`postgresql:` URL with credentials, a database name and loopback host; no query options or fragment |
| `TRUEID_CORS_ORIGINS` | Empty | Up to eight unique, exact loopback HTTP origins separated by commas; empty denies browser cross-origin access |
| `TRUEID_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; minimum emitted severity |
| `TRUEID_AUTH0_TENANT_MODE` | Blank | Must be `sandbox` when enabling Auth0 |
| `TRUEID_AUTH0_ISSUER` | Blank | Exact HTTPS developer-tenant issuer with trailing slash |
| `TRUEID_AUTH0_AUDIENCE` | Blank | TrueID API identifier |
| `TRUEID_AUTH0_MOBILE_CLIENT_ID` | Blank | Public Native application client ID |
| `TRUEID_QOREID_MODE` | Blank | Must be `sandbox` when enabling verification |
| `TRUEID_VERIFICATION_PROVIDER` | `qoreid` | `qoreid` preserves existing behavior; `monnify` selects the unavailable boundary without fallback |
| `TRUEID_MONNIFY_MODE` | `disabled` | Only blank/`disabled` accepted; nonempty Monnify credential/host/activation settings are rejected |
| `TRUEID_QOREID_ROUTE` | Blank | Only the authorized `nin` route |
| `TRUEID_QOREID_TEST_CLIENT_ID` | Blank | Dashboard Test client ID, outside source control |
| `TRUEID_QOREID_TEST_CLIENT_SECRET` | Blank | Matching Test secret, outside source control |
| `TRUEID_CREDENTIAL_SIGNING_MODE` | Blank | Only `test`, and only with `NODE_ENV=test` |
| `TRUEID_TEST_SIGNING_KEY_ID` | Blank | `test-UUIDv4` matching an ignored dedicated Test key file |

Auth0 settings are all-or-none. Blank settings leave health public and protected
routes closed. No Auth0 client secret is required. The account/auth guide documents
Native PKCE, RS256, RFC 9068 and `account:self` setup.
QoreID settings are also all-or-none. The verification guide documents its shared
Test/Live host, Test input restriction and provider failure handling.
Monnify provider calls remain disabled; its preparation guide distinguishes offline
contract examples from a real Sandbox facility. No Monnify key configuration is needed.
Signing settings are all-or-none and rejected outside Test configuration. The
ignored `.env.test` and `test-keys/` contain the generated local Test setup.
`npm run keys:test` generates a new dedicated Test key; `npm run start:test` starts
with `.env.test` after building. See the credential guide before rotation.

Invalid configuration fails startup without logging the supplied value. Pool
settings are intentionally fixed: maximum five connections, 3-second connection
timeout, 10-second idle timeout, 5-second statement and lock timeouts, UTC session
timezone. No TLS/remote database or production setup is provided by this stage.

## Implemented endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/v1/health` | `{ "demo": true, "status": "ready" }` only when the database and expected schema are available; otherwise 503 |
| GET | `/api/v1/health/live` | `{ "demo": true, "status": "alive" }`, independent of database readiness |
| POST | `/api/v1/users/me` | Bearer-authenticated account creation/resumption; absent/empty body, no caller-selected identity |
| GET | `/api/v1/users/me` | Bearer-authenticated current-account metadata only |
| POST | `/api/v1/verifications` | Authenticated Test NIN submission; UUIDv4 Idempotency-Key; minimum provider inputs only |
| GET | `/api/v1/verifications/:id` | Authenticated owner's minimal outcome/status only |
| POST | `/api/v1/credentials` | Owner's latest verified outcome only; returns minimal signed Test credential and reference |
| POST | `/api/v1/credentials/check` | Authenticated owner's signature, claims, expiration and current-status check |
| GET | `/api/v1/credentials/:id/status` | Authenticated owner's credential status metadata |
| POST | `/api/v1/credentials/:id/revoke` | Authenticated owner's idempotent terminal revocation |
| GET | `/api/v1/consent/partners/:id` | Active registered partner name and public ID |
| POST | `/api/v1/consent/invitations` | Owner creates a single-use partner/credential-bound routing token; no approval implied |
| GET | `/api/v1/consent/requests` | Owner's latest 100 request/consent metadata records |
| GET | `/api/v1/consent/requests/:id` | Owner reviews partner, purpose, scope, expiry and revision |
| GET | `/api/v1/consent/requests/:id/history` | Owner's coded audit events; optional scoped cursor, no identity or disclosed values |
| POST | `/api/v1/consent/requests/:id/decision` | Owner explicitly approves a subset/expiry or declines the reviewed revision |
| POST | `/api/v1/consent/requests/:id/revoke` | Owner's terminal idempotent grant revocation |
| POST | `/api/v1/partner/requests` | Registered partner requests exact allowlisted fields, purpose and expiry using its bound invitation |
| GET | `/api/v1/partner/requests/:id` | Authenticated partner's request/approval metadata; no values |
| POST | `/api/v1/partner/requests/:id/disclosure` | Exact current approval context; only approved Test verification fields and pairwise ID |

Nest URI versioning uses the `/api` prefix and version `1`, preserving existing
health URLs. Unversioned and unknown-version routes return 404. The global guard
protects registered routes by default, with health explicitly public. Account
responses are not cached; 401 responses include a Bearer challenge.

Errors return `demo: true`, a server-generated `requestId` and `error: { code, message }` with fixed messages.
Unknown routes, parser errors, validation failures and database errors never echo
the request URL, submitted values, exception details, tokens or database credentials.
JSON bodies have a 16 KiB limit. Global DTO validation rejects unknown fields and
does not implicitly coerce values. Test-only validation routes are not in the app.
Browser origins must exactly match the local allowlist; an empty list denies
browser cross-origin access. CORS is not authorization.

## Request IDs and redacted logging

Every request gets a fresh server-generated UUIDv4 in `X-Request-Id`, including
parser, CORS and routing errors. Caller-supplied IDs are ignored. Browser clients
may read that response header through CORS. `AsyncLocalStorage` provides request
context without storing values on a shared singleton; concurrent requests stay
separate. Error bodies use the same ID as the response header.

Operational logs are JSON lines with a UTC ISO timestamp, level and fixed event
name. HTTP records allow only the request ID, normalized method, fixed health
route/account/verification/credential label (or `unmatched`), status, duration and completion/abort flag. Error
records allow only a known error code, status and request ID. Startup and migration
records allow only the local port or applied count. No arbitrary metadata objects
or exception messages are serialized. Raw URLs/paths, query strings, headers,
bodies, secrets, tokens, identity numbers, credential contents and disclosed values
are omitted rather than copied into logs and masked afterward.

Info/warn records use stdout; error records use stderr. Nest's general logger
remains disabled so framework messages cannot bypass this policy. All application
logging goes through `StructuredLogger`. Codes such as `startup_failed`,
`migration_failed` and `database_unavailable` indicate configuration/port,
database/migration-history or database-connectivity troubleshooting respectively.
AuditModule writes fixed verification/credential/consent lifecycle metadata in domain transactions.

## Database and migrations

Runtime PostgreSQL connections use `pg` with UTC, a bounded pool, connection/query/
lock timeouts and parameterized values. Schema changes never run automatically on
HTTP startup. Run `npm run db:migrate` explicitly.

The runner holds a PostgreSQL advisory transaction lock, validates the ordered
applied history and SHA-256 checksums, then applies pending SQL and ledger entries
in one transaction. A failure rolls everything back. Applied migrations are
immutable: add a new numbered SQL file instead of editing an old one. SQL files
use LF endings to keep checksums stable. Readiness rejects missing, edited, pending
or unknown migration history and missing expected account/verification/credential/audit tables.

Storage contains internal `accounts`, minimal `account_identities` bindings,
`verification_attempts`, credential references/status, public verification keys,
coded verification/credential/consent audit events, registered partner clients,
pairwise mappings, hashed invitations, consent requests/decisions and the migration ledger. Accounts have
database-generated random UUIDv4 IDs, `active`/`disabled` status and `timestamptz`
metadata with lifecycle constraints and a database-maintained update timestamp.
The primary key supplies the unique account index; there is no additional access
pattern needing an index yet. Binding indexes enforce issuer/subject and account
uniqueness. Only the authenticated owner can read account metadata; internal IDs
are not partner identifiers.
No names, identity numbers, contacts, documents or credential contents are stored.
Signed credential contents are not stored. Dedicated Test keys are available only
in explicit Test configuration; private bytes stay in ignored local files. The
production signing interface delegates to managed KMS/HSM; production remains
disabled and no production key or cloud backup is added.

## Checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
# Runs those checks sequentially:
npm run check
```

GitHub Actions additionally runs `npm audit --omit=dev --audit-level=high`,
`npm run test:postgres` against a disposable PostgreSQL service and a container
smoke check. These require external tooling; see the CI/CD guide for setup and
the exact validation results. `start:runtime`, `db:migrate:runtime` and
`smoke:runtime` use injected environment variables without loading an `.env` file.

Tests cover configuration boundaries, safe errors, DTO input rejection, exact CORS,
URI versioning, absent business routes, request ID correlation/concurrency, log
redaction and thresholds, readiness/liveness, PostgreSQL account constraints, migration idempotency,
checksum/history rejection and transactional DDL rollback. Migration tests use
PGlite's embedded PostgreSQL engine. They do not substitute for testing a TCP
PostgreSQL server, pooled connections or simultaneous advisory-lock contenders.
The runtime never uses PGlite or an in-memory fallback.

Account tests cover cryptographic token validation, default denial, ownership,
ID/body/query substitution, disabled accounts and idempotent provisioning.
Verification tests cover outcome policy, redaction, duplicate/concurrent requests,
ownership, account disabling, timeouts, state constraints and transactional audit
rollback. `npm run test:qoreid` separately runs the Test integration when
`TRUEID_RUN_QOREID_SANDBOX_TESTS=true`; otherwise it skips. This client currently
authenticates, but the NIN Test endpoint returns 403.
Credential tests cover verified-only issuance, database constraints, minimal claims,
tampering, expiry, revocation, key rotation, account isolation, race handling and
reverification preserving old grant references. Consent/disclosure tests enforce
explicit decisions, subsets, scope/revision matching, terminal states, pairwise
separation, account/partner isolation, single-use invitations and audit rollback.
Pilot partner checks additionally cover scoped permissions, rotation, revoked keys,
credential audit rollback, history authorization/pagination, migration compatibility
and audit redaction. No public partner onboarding endpoint exists.
`npm run test:auth0` separately opts into real developer-tenant JWT/JWKS validation;
it requires externally supplied sandbox configuration/tokens and otherwise reports
one skip. Native PKCE and provider setup remain external integration work.

Implementation references: [Nest validation](https://docs.nestjs.com/techniques/validation),
[node-postgres transactions](https://node-postgres.com/features/transactions),
[PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).
Local checks do not establish production security or regulatory compliance.
