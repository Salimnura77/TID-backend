# Account/auth slice report — 2026-10-13

Implemented only authenticated account creation/resumption and self-account access.
The design was proposed before edits, and Auth0 development-tenant PKCE was selected
by the user. Existing npm scripts, module layout, logging, health shapes, migrations
and separate frontend projects were preserved. Nothing was deployed or published.

## Behavior and decisions

- `POST /api/v1/users/me` atomically creates/resumes the caller's account;
  `GET /api/v1/users/me` reads only that account. Both require a valid scoped access
  token from the configured Auth0 Native client. Inputs cannot select another account.
- A global guard denies registered routes by default. Only explicit `@Public()`
  routes bypass it; health remains public. Duplicate/malformed Bearer headers fail.
- Auth0 validation pins issuer, API audience, native client ID, RS256 and RFC 9068
  token type. ID tokens, invalid signatures/times, machine/delegated principals and
  missing permissions cannot provision/read accounts. No custom passwords, local
  token issuer, Auth0 Management calls or runtime test-token bypass were added.
- Private issuer/subject maps to the existing database-generated random UUIDv4 account
  through a new constrained binding table. Transactions/unique keys protect creation
  and remove losing candidates. Disabled accounts deny read/resumption. Only minimum
  metadata is persisted; no profile claims, contacts, tokens or identity documents.
- The backend requires public Auth0 configuration and no Auth0 client secret.
  Incomplete settings fail startup; absent settings leave protected access closed.
  Internal account IDs are self-service metadata, never partner identifiers.
- The normal suite uses ephemeral keys, opaque random technical test identifiers and
  isolated component databases. No fictional human profiles or production seed data
  were added. The real Auth0 integration test is separately gated and never creates
  Auth0 users. Verification/credentials/partners/consent/audit remain unimplemented.

## Changed files

| New files | Purpose |
| --- | --- |
| `src/auth/identity.ts`, `src/auth/public.decorator.ts`, `src/auth/auth.guard.ts`, `src/auth/auth0-token-verifier.ts` | Typed authentication boundary, public-route metadata, global guard and Auth0 JWT verifier |
| `src/users/account.repository.ts`, `src/users/empty-input.pipe.ts`, `src/users/users.controller.ts` | Transaction-safe scoped persistence, zero-input validation and self-service routes |
| `migrations/002_account_identities.sql` | Minimal unique issuer/subject account binding with FK constraint |
| `tests/auth-support.ts`, `tests/auth.test.ts`, `tests/accounts.test.ts`, `tests/auth0-sandbox.integration.ts` | Ephemeral crypto/database helpers, adversarial token/ownership tests and opt-in real provider test |
| `docs/account-auth.md`, `docs/account-auth-report.md` | API/setup contract and exact stage results |

| Modified files | Purpose |
| --- | --- |
| `src/auth/auth.module.ts`, `src/users/users.module.ts` | Register this slice's providers/controller |
| `src/config/runtime-config.ts`, `.env.example` | All-or-none public Auth0 sandbox configuration; no provider secret values |
| `src/database/database.service.ts`, `src/database/migrations.ts` | Scoped client/transaction access and binding-table readiness |
| `src/health/health.controller.ts` | Explicit public-route marker |
| `src/http/api-error.ts`, `src/http/safe-exception.filter.ts` | Safe auth-unavailable code and Bearer challenge |
| `src/logging/structured-logger.ts`, `src/http/request-logging.middleware.ts` | Static account-self log label; no account IDs/claims logged |
| `package.json`, `package-lock.json` | Add pinned-lockfile JOSE dependency and explicit `test:auth0` command; preserve existing commands |
| `tests/http.test.ts`, `tests/migrations.test.ts` | Existing infrastructure tests remain valid under the guard/new migration; unconfigured-auth closure test |
| `README.md`, `docs/modules.md`, `docs/stages.md`, `docs/foundation-report.md` | Current scope/setup and sandbox-based future verification plan; historical foundation note |

Migration 001, Compose, sibling Expo/Next.js/Figma projects and signing-key files were
not changed. No seed script, actual `.env`, provider token file or real identity data
was generated. Dependency declarations match the lockfile (`jose` resolved to 6.2.12).

## Exact final verification

`npm run check` finished with exit code **0**, sequentially executing:

| Command | Result |
| --- | --- |
| `npm test` | 35 passed; 0 failed, skipped, cancelled or todo; test compilation passed |
| `npm run typecheck` | Exit 0; no diagnostics |
| `npm run lint` | Exit 0; zero warnings/errors |
| `npm run build` | Exit 0; service/migration compilation passed |

`npm run test:auth0` finished with exit code 0 but **0 passed, 0 failed, 1 skipped**.
Sandbox opt-in/authorized tokens were not configured. This is not a successful
Auth0 end-to-end test, and no provider was contacted.

Tests include wrong-user ID/path/body/query/header attempts; invalid issuer/audience/
client/signature/type/time/scope; duplicate Authorization headers; global default
denial; distinct issuer bindings; first-time and resumed concurrent calls; unique/FK
constraints; disabled-account rollback; and token/subject/account-ID log redaction.

A compiled-service smoke check on an ephemeral loopback port returned liveness 200,
unauthenticated account creation 401 with Bearer challenge/no-store, and unconfigured
authentication 503. Error/header IDs matched and submitted token syntax stayed out
of logs. The temporary server was stopped. Local commands used Node child-process
execution because the default shell's environment setup remains unavailable.

## External setup and verification still required

Follow [the Auth0 setup guide](account-auth.md): configure an approved development
tenant, Native public client/PKCE S256/callbacks, API audience/RS256/RFC 9068, the
`account:self` permission, and the four public backend settings. Restrict the Native
client's grant types at Auth0; a JWT does not prove its original PKCE transaction.
The separate mobile project still needs OIDC SDK/login wiring. Inject two authorized
sandbox users' access tokens privately to run `npm run test:auth0`.

`docker --version` and `psql --version` returned `ENOENT`. Successful runtime
migration/provisioning through TCP PostgreSQL and true multi-connection contention
remain unverified. Component databases used PGlite's PostgreSQL engine; its
transaction scheduling is not a concurrency guarantee for a networked deployment.
Production configuration remains unsupported. This slice makes no identity/KYC,
production-security or regulatory-compliance claim.
