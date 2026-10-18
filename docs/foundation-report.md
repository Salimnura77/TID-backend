# Backend foundation report — 2026-10-12

This is the historical foundation baseline. The next account slice is documented
in [the account/auth guide](account-auth.md).

Only the backend foundation was implemented. The existing standalone NestJS
service remains at the workspace root, with no frontend changes or project moves.
No business endpoints, verification adapters, signing keys, consent algorithms,
partner clients or domain audit records were implemented in this change.

## Inspection and smallest structure

The workspace already had a NestJS/npm service, a lockfile, strict TypeScript,
validation/errors, health controllers, a PostgreSQL pool, transactional migrations,
an optional PostgreSQL-only Compose workflow and four test files. Ancestor project
instruction files were checked again and were absent. The existing mobile contract
inventory remains relevant; sibling Expo, Next.js and Figma/Vite files were not edited.

The smallest extension keeps the existing directory layout and adds seven module
declarations plus shared logging/context infrastructure. It does not need a second
`backend/` package, another database workflow, a Nest CLI dependency or a new
logging library. Dependencies and the lockfile are unchanged.

[Module responsibilities and dependency boundaries](modules.md) describe Auth,
Users, Verification, Credentials, Partners, Consent, Audit, Health, configuration,
logging and database infrastructure. The seven domain modules have no controllers,
providers or exported services yet. Operational logging is separate from Audit.

## Resulting behavior

- Validated local environment includes `TRUEID_LOG_LEVEL`; existing local database,
  port, origin and development/test boundaries are retained.
- `LoggingModule` emits UTC JSON lines from fixed events and event-specific field
  allowlists. It omits raw URLs, paths, query strings, bodies, headers, exceptions,
  secrets, tokens, identity values and arbitrary objects. The default Nest logger
  stays disabled so it cannot bypass this policy.
- Each HTTP request gets a new server-generated UUIDv4, irrespective of the incoming
  header. The response uses `X-Request-Id`; safe error bodies contain the same ID.
  `AsyncLocalStorage` isolates concurrent work. Middleware precedes JSON parsing
  and CORS, so those errors are correlated too.
- Nest URI versioning with `/api` and version `1` preserves `/api/v1/health` and
  `/api/v1/health/live`. Unversioned/unknown-version and business routes return 404.
- Existing strict global DTO validation, JSON limits, safe errors, health checks,
  UTC pool settings and explicit migrations remain in place.
- Existing Compose, migrations and the local database workflow are reused.
  No additional database service or new domain table was added.
- README now documents the structure, module responsibilities, environment
  variables, logging, request IDs, database settings and exact local commands.
  `npm run build:watch` supports recompilation alongside the existing dev command.

## Files changed

| New files | Purpose |
| --- | --- |
| `src/auth/auth.module.ts`, `src/users/users.module.ts`, `src/verification/verification.module.ts`, `src/credentials/credentials.module.ts`, `src/partners/partners.module.ts`, `src/consent/consent.module.ts`, `src/audit/audit.module.ts` | Seven empty domain module boundaries |
| `src/logging/log-level.ts`, `src/logging/request-context.ts`, `src/logging/structured-logger.ts`, `src/logging/logging.module.ts` | Log-level definitions, isolated context and allowlisted JSON logger |
| `src/http/request-logging.middleware.ts` | Server-generated request ID and completion/abort logging |
| `tests/logging.test.ts` | Metadata redaction, thresholds and concurrent context tests |
| `docs/modules.md`, `docs/foundation-report.md` | Responsibilities and current verification report |

| Modified files | Purpose |
| --- | --- |
| `src/app.module.ts` | Register domain and logging modules |
| `src/config/runtime-config.ts`, `.env.example` | Validate/document minimum log level |
| `src/http/configure-http.ts`, `src/http/safe-exception.filter.ts`, `src/health/health.controller.ts` | URI versioning, request middleware, CORS header exposure and correlated safe errors |
| `src/database/database.service.ts`, `src/database/pool.ts`, `src/main.ts`, `scripts/migrate.ts` | Use the shared logger for runtime, pool and migration events |
| `tests/config.test.ts`, `tests/http.test.ts`, `tests/startup.test.ts` | Configuration, versioning, absent routes, request/error correlation and executable log redaction |
| `package.json` | Add `build:watch`; no dependency change |
| `README.md`, `docs/stages.md`, `docs/stage-1-report.md` | Current setup/infrastructure documentation and historical report link |

## Exact final check results

Checks were invoked through the installed npm CLI using Node because the default
shell tool continues to fail during environment setup. These are the results for
the final source, not the initially interrupted baseline check chain.

| Command | Exit code | Result |
| --- | --- | --- |
| `npm test` | 0 | 19 passed; 0 failed, skipped, cancelled or todo; test compilation passed |
| `npm run typecheck` | 0 | Passed; no diagnostics |
| `npm run lint` | 0 | Passed; zero warnings/errors with `--max-warnings 0` |
| `npm run build` | 0 | Passed; compiled service and migration script |

An initial baseline `npm run check` completed the original 14 tests and typecheck
before its 50-second harness timeout stopped the chain during lint. The final
tests and remaining checks above completed individually without a timeout. The
aggregate `npm run check` command remains available for local use.

Tests cover logging omissions (including sensitive values under approved field
names), severity thresholds, concurrent context isolation, request-ID generation
and response/log correlation, parser/CORS failures, versioned routing, absent
business routes and existing configuration/migration/account invariants.

A compiled-service smoke check used an ephemeral loopback port and an intentionally
unavailable local database. Liveness returned 200; readiness returned 503 with
`service_unavailable`. Header/body/error/completion logs used the same request ID,
health route labels were correct, and supplied authorization/header/query fixtures
did not appear in the logs. The temporary server was stopped. Manifest dependency
declarations still match the unchanged lockfile.

## Blockers and limits

`docker --version` and `psql --version` both returned `ENOENT` on the inspected path.
Compose startup, successful migration execution through a TCP PostgreSQL server,
pool behavior against a running server and concurrent advisory-lock contenders
remain unverified. The migration tests passed using PGlite's embedded PostgreSQL
engine. There is no in-memory runtime fallback.

This foundation supports local fictional development only and rejects production
configuration. It makes no production-security, identity-verification or regulatory
compliance claim. No real email/SMS or identity provider was contacted.
