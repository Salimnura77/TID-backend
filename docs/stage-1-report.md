# Stage 1 report — 2026-10-12

This records the initial foundation pass. The subsequent module/logging/versioning
changes and current checks are in [the foundation report](foundation-report.md).

The separate NestJS/TypeScript service foundation is implemented and checked.
The complete MVP remains future work. No existing app project was changed.

## Decisions

- The backend workspace was empty, including hidden entries. There was no existing
  Git repository, manifest, lockfile, project instruction file or test suite here.
  Ancestor `AGENTS.md` files were absent. Relevant sibling project instructions,
  manifests, domain/service/wire contracts and test files were inspected before edits.
- Use an isolated npm project and lockfile, NestJS 11, TypeScript strict mode and
  modular configuration/database/health boundaries. TypeScript compilation preserves
  decorator metadata used by Nest injection and DTO validation.
- Port 4200 and loopback keep the existing mobile pilot on 4100. No mobile adapter,
  website or Figma/Vite files were overwritten or reorganized. The new service does
  not yet accept the existing mobile pairing protocol.
- Keep the account schema minimal: random internal UUIDv4 IDs, lifecycle status and
  UTC timestamps. No account API, identity attributes or provider integration yet.
- Use explicit, ordered, immutable SQL migrations and a checksum ledger. Migration
  SQL and ledger changes share one transaction and PostgreSQL advisory lock.
  Readiness verifies database access and the expected applied migration history.
- Disable general request/Nest error logging, return fixed coded errors, cap JSON
  bodies and configure strict global DTO validation and exact local CORS.
- Reject production configuration in this stage. No signing keys are generated or
  used. KMS/HSM and labelled test signing keys belong to the credential stage.

## Files created

All listed files are new in this workspace.

| Area | Files |
| --- | --- |
| Package/tooling | `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`, `eslint.config.mjs` |
| Local setup | `.env.example`, `.gitignore`, `.gitattributes`, `compose.yaml` |
| Service | `src/main.ts`, `src/app.module.ts` |
| Configuration | `src/config/runtime-config.ts`, `src/config/runtime-config.module.ts` |
| HTTP boundary | `src/http/api-error.ts`, `src/http/configure-http.ts`, `src/http/safe-exception.filter.ts` |
| PostgreSQL | `src/database/database.module.ts`, `src/database/database.service.ts`, `src/database/pool.ts`, `src/database/sql-executor.ts`, `src/database/migrations.ts` |
| Migration | `migrations/001_accounts.sql`, `scripts/migrate.ts` |
| Health | `src/health/health.controller.ts`, `src/health/health.module.ts` |
| Tests | `tests/config.test.ts`, `tests/http.test.ts`, `tests/migrations.test.ts`, `tests/startup.test.ts` |
| Documentation | `README.md`, `docs/mobile-contract.md`, `docs/stages.md`, `docs/stage-1-report.md` |

Ignored dependency, cache and compilation directories were generated locally.
No `.env`, signing key, real identity record or local document image was created.

## Verification

Final `npm run check` completed with exit code 0, sequentially executing:

| Command | Result |
| --- | --- |
| `npm test` | 14 passed; 0 failed, skipped or cancelled; includes test compilation |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with zero warnings |
| `npm run build` | Passed |

Tests exercise local configuration/production rejection, safe startup logging,
unknown/invalid DTO fields, implicit coercion denial, parser/size errors, exact CORS,
safe exception responses, readiness/liveness, PostgreSQL account constraints,
migration repetition, checksum/unknown-history rejection and transactional DDL
rollback. Database tests execute the embedded PostgreSQL engine through PGlite.

A final smoke check ran the compiled service on an ephemeral loopback port with
an intentionally unavailable local database. Liveness returned 200; readiness
returned 503 with a fixed `service_unavailable` response. Logs contained only the
labelled local startup message and port. The temporary process was stopped.
The npm lockfile dependency declarations match the manifest.

The default shell tool failed during environment setup. Read-only inspection and
local checks used Node child-process execution. Dependency installation used the
approved elevated shell path after restricted registry access returned `EACCES`.
The environment issue did not prevent the checks from completing.

## Remaining verification and next stage

Docker and `psql` were not available on the inspected execution path. A running TCP
PostgreSQL server, Compose startup, pooled connections, successful runtime migration
CLI execution and contention between concurrent migrators have not been verified.
The embedded engine tests do not establish those results. No real external identity
provider, email or SMS was called.

Stage 2 is OIDC Authorization Code + PKCE authentication and account ownership.
Credentials, partners, pairwise mappings, consent, disclosure and audit history
remain unimplemented. This is a local pilot foundation, with no claim of production
security or regulatory compliance.
