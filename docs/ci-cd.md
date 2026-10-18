# CI, release preparation and external setup

Prepared on 2026-10-18 for GitHub Actions. The repository is
`Salimnura77/TID-backend`; its visibility and upload status are confirmed separately.
Hosting has not been selected. This stage adds CI and
optional container delivery; there is no application deployment job yet.

## Pipeline

```text
Pull request / push to main / manual run
  -> locked npm install (Node 24, npm 11.4.2)
  -> tests + typecheck + lint + build
  -> runtime dependency advisory check
  -> disposable TCP PostgreSQL integration tests
  -> build non-root pilot container
  -> migrate disposable CI database + health/auth smoke checks
  -> retain the tested image archive for 7 days

Manual release (publishing defaults to false)
  -> the same complete CI workflow
  -> default branch + explicit publishing input + repository opt-in
  -> protected container-release environment
  -> validate artifact checksum, image ID and source revision
  -> publish that exact image to GHCR and record its digest
```

CI runs on GitHub-hosted Ubuntu 24.04 with PostgreSQL 17 service containers. It
uses no Auth0 token, identity provider secret, partner secret or signing key.
The clearly labelled database password exists only for disposable CI services.
The existing local Compose database and application environment files are unchanged.

`.github/workflows/ci.yml` is also reusable by the manual release workflow.
Actions are pinned to full commit SHAs, checkout does not persist credentials,
and ordinary CI receives only `contents: read`. There is no privileged
`pull_request_target` or `workflow_run` handler that consumes untrusted PR code.
The publish job alone receives `packages: write`. Weekly Dependabot PRs cover
npm, Actions and Docker; updates are reviewed and checked before merging.

No new runtime dependency is added. Existing npm commands keep their behavior.
The runtime advisory check fails on high/critical production dependency findings;
registry/network failures also block release. It does not scan OS packages.

## Container and release limits

The multi-stage Dockerfile copies only built service code, production dependencies,
migrations and package metadata into the runtime image. It runs as the existing
unprivileged `node` user. The allowlist `.dockerignore` excludes local environment
files, Test signing keys, partner handoff files, tests and generated outputs from
the build context. CI also checks for excluded files in the final image.

Runtime commands read injected environment variables without requiring `.env`:

```powershell
npm run build
npm run db:migrate:runtime
npm run start:runtime
# In another terminal, after startup:
npm run smoke:runtime
```

The service still accepts only development/test configuration, loopback PostgreSQL
and loopback HTTP/CORS. CI uses Linux host networking so the container can reach
the disposable database without widening those boundaries. This image is a pilot
artifact, not a cloud deployment configuration. A regular bridged container with
published ports alone is insufficient while the listener remains on loopback.

The smoke check verifies readiness, liveness and rejection of an anonymous account
request. Docker's healthcheck uses liveness; readiness is checked before release.
Migration is an explicit one-off command using the same image, never automatic
HTTP startup. CI runs the container with a read-only filesystem, dropped capabilities
and no-new-privileges. Monnify calls remain disabled and production mode still fails.

Each release run builds once and promotes its tested artifact without rebuilding.
The archive checksum, Docker image ID and source commit are checked before pushing.
The image tag is `ghcr.io/salimnura77/tid-backend/backend:sha-<full-commit-sha>`.
Use the recorded `image@sha256:...` reference for future promotion or rollback:
tags can be overwritten. Node 24 and PostgreSQL 17 base tags can receive patches,
so rebuilding a commit may produce a different digest. Retain previously approved
digests before deploying; do not automatically reverse database migrations.

## GitHub setup needed now

1. Use `Salimnura77/TID-backend`, preferably private, with this workspace at its
   root and `main` as the default branch. Upload only source/configuration/docs;
   preserve `.gitignore`. Do not upload `.env*` other than `.env.example`, key
   directories, dependencies, build output, `.cache` or release archives.
2. Enable GitHub Actions and permit the pinned official actions. Configure billing
   or included minutes/storage as needed for the account. The first hosted run is
   required evidence for the PostgreSQL and container jobs.
3. Protect `main` with PR review and the `Validate workflows`,
   `Tests, types, lint and PostgreSQL` and `Build and smoke-test container` checks
   after their first run. Require reviews
   for workflow and migration changes. If the default branch differs, update the
   CI push branch filter. Restrict settings and release configuration to maintainers.
4. Ordinary CI needs no manually configured secrets. Keep publishing disabled
   unless you explicitly choose to release an image later.
5. For optional image publication, create `container-release`, restrict it to the
   default branch and require a reviewer where the GitHub plan supports it. Set
   repository variable `TRUEID_ENABLE_IMAGE_PUBLISH=true` only when publication is
   authorized. Run **Prepare pilot release** on the default branch with `publish`
   selected. GitHub's scoped `GITHUB_TOKEN` authenticates GHCR; no personal access
   token is stored in source. Confirm the package stays private and repository access
   is correct. Environment protections require repository settings; YAML alone
   does not create required reviewers or branch restrictions.

Creating/pushing the repository can trigger CI, but neither a push nor an ordinary
CI run publishes an image or deploys the application.

## TCP PostgreSQL tests locally

These tests are deliberately separate from the offline default suite. They require
a dedicated, disposable PostgreSQL 17+ instance and `trueid_ci` administrator
database. The test role needs CREATEDB on that disposable instance. Supply its
loopback URL through `TRUEID_TEST_DATABASE_URL`; never reuse the pilot database URL.

```powershell
# With a dedicated local CI database already provisioned:
$env:TRUEID_TEST_DATABASE_URL = 'postgresql://<test-role>:<test-password>@127.0.0.1:<port>/trueid_ci'
npm run test:postgres
```

The suite fails if this setting is absent or unsafe; it does not silently skip.
It creates a random `trueid_ci_<uuid>` database, applies migrations there and drops
only that database after closing its pools. Tests cover simultaneous migration,
transactional DDL rollback, checksum rejection, concurrent account resumption,
one-winner partner key rotation and denial of a previously authenticated revoked
key. Technical test accounts are confined to this temporary database; there are
no startup seeds, human identity profiles or real identity values.

The local safety tests also prove that default `DATABASE_URL`, remote URLs and
other database names cannot select the target, and errors omit connection secrets.
Cancellation can leave a disposable test database behind; remove it only after
confirming its generated name and that no test process is using it.

## External setup before hosting a usable pilot

| Needed | Purpose and remaining work |
| --- | --- |
| Hosting account/region and domain | Choose the host before adding its deployment job. Add reviewed listener, HTTPS/CORS and trusted-proxy configuration; the present loopback-only runtime cannot simply be deployed publicly. |
| Managed PostgreSQL | Provision an isolated database, TLS trust and separate migration/runtime roles. Remote/TLS database support still requires code and tests. Decide retention, restore procedures and operator access. |
| Deployment identity and secret manager | Use the host's GitHub OIDC trust with least privilege when supported. Keep runtime secrets outside source and image layers; staging and production need separate identities/configuration. |
| Auth0 developer tenant and Native application | Configure issuer, API audience, mobile client ID, RS256/RFC 9068 access tokens, `account:self`, and mobile callback/logout URLs. The mobile app still needs Authorization Code + PKCE wiring. Backend/mobile code needs no Auth0 client secret for that flow. |
| Approved verification access | QoreID Test NIN permission remains unresolved (the prior Test call returned 403). Monnify has no approved Test facility and remains disabled. Obtain approved test documentation/access before its activation slice; do not put Live keys into this pilot. |
| Managed KMS/HSM signer | Choose and implement the production signer with key IDs, IAM and rotation before production credential issuance. Current file keys are dedicated Test keys only. |
| Actual pilot partner | Register the authorized partner using the operator commands, choose minimal endpoint permissions, and deliver/rotate its key through an approved secret channel. No public onboarding or seeded partner is added. |
| Operations | Assign deployment and incident owners, configure redacted log collection/alerts, and decide consent/audit retention. A hosting job should promote an approved image digest, migrate once, check readiness and roll back the image only when schema-compatible. |

Production activation remains a separate implementation and authorization step.
Local checks and an image build do not establish production security or legal KYC
compliance. No cloud account, production key, paid resource or application deployment
is created by these files.

## Changed files and validation

- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`
- `Dockerfile`, `.dockerignore`, `.gitattributes`, `.gitignore`
- `package.json`, `scripts/smoke-runtime.ts`
- `tests/postgres-support.ts`, `tests/postgres-safety.test.ts`, `tests/postgres.integration.ts`
- `README.md`, `docs/stages.md`, this guide

Validation on 2026-10-18:

| Command/check | Observed result |
| --- | --- |
| Baseline `npm run check` | Exit 0; 111 passed, 0 failed, 0 skipped; typecheck, lint and build passed |
| Final `npm run check` | Exit 0; 113 passed, 0 failed, 0 skipped; typecheck, lint and build passed |
| `npm audit --omit=dev --audit-level=high` | Exit 0; 0 vulnerabilities reported |
| `actionlint -no-color -shellcheck= -pyflakes= .github/workflows/ci.yml .github/workflows/release.yml` (v1.7.12) | Exit 0; workflow syntax/expressions validated; local ShellCheck/Pyflakes integration disabled because those tools are absent |
| `node --test dist-test/tests/postgres-safety.test.js` | Exit 0; 2 passed |
| `node --test dist-test/tests/postgres.integration.js` | Exit 1 as designed with missing `TRUEID_TEST_DATABASE_URL`; no database was contacted |
| Docker build and live TCP PostgreSQL scenarios | Not run locally: Docker/PostgreSQL tools and the dedicated test database are unavailable; required hosted CI gates remain to run |

The final default suite took 163,441.5981 ms. The downloaded workflow validator
was checked against its official SHA-256 release checksum and is stored only in
ignored `.cache/ci-tools`. Git ignore checks confirmed environment/key/generated
paths are excluded. No business endpoint, schema migration, frontend or provider
activation is included in this stage. These results do not claim that hosted CI
or application deployment has run.

References: [GitHub PostgreSQL service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers),
[GitHub container publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[GitHub secrets and OIDC](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
[Docker build practices](https://docs.docker.com/build/building/best-practices/).
