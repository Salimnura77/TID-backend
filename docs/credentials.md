# Test credential issuance, status and revocation

Implemented on 2026-10-14. Credentials are issued only from the caller's **latest
verified backend outcome**. All endpoints retain default-deny Auth0 authentication,
account:self scope, active-account checks and no-store responses. There is no
production signing configuration, cloud backup, seeded user or invented profile.

## API

| Method | Route | Input and result |
| --- | --- | --- |
| POST | /api/v1/credentials | Exactly verificationId (UUIDv4); returns credential metadata, signedCredential and created |
| GET | /api/v1/credentials/:id/status | Owner's metadata and effective status only |
| POST | /api/v1/credentials/:id/revoke | Empty body; idempotent terminal revocation |
| POST | /api/v1/credentials/check | Exactly credential (compact signed string); verifies signature, claims, ownership, expiry and current revocation status |

Unknown fields and query parameters are rejected. Other users cannot issue from,
read, validate or revoke the owner's reference. Malformed/tampered credentials
return fixed credential_invalid errors. A correctly signed expired, revoked or
superseded credential returns valid=false with its status. A credential cannot
authenticate to the API as an OIDC access token.

## Claims and persistence

The signed Test JWT has only iss, aud, jti, iat, exp, verification=verified and
test=true. Its issuer/audience identify this Test pilot and its type is
trueid-test-credential+jwt. jti is a fresh random credential UUID, never the private
account ID, an identity number or a partner identifier. Lifetime is five minutes.
No names, NIN/BVN, documents, provider references or identity attributes are included.

PostgreSQL stores credential references, verification/account bindings, key IDs,
status and UTC timestamps. It stores public verification keys and coded audit
events; signed credential contents and private keys are not stored in the database.

Migration 004 adds these tables and enforces a verified-outcome foreign key, one
credential per verification, one stored active credential per account, bounded
validity and immutable reference/claim metadata. Revoked/superseded references
cannot become active again. Expiry is checked against current UTC time at its
exact boundary. Server clocks need reliable time synchronization in deployment.

Issuance plans an owned reference in a short transaction, signs outside the
transaction, then rechecks active ownership and the latest verified result before
committing. A five-second signing deadline fails closed. Signature verification
also checks the signer's returned bytes against its advertised public key.
Concurrent issuance resumes one immutable reference; replays retain its original
expiry and claims. Audit failure rolls back issuance/revocation/supersession.

## Reverification and consent

A new verified attempt produces a different credential ID and supersedes any
prior active credential atomically with issuance. Existing revoked references stay
revoked. Reissuing an old/revoked/expired result cannot extend or restore it.

Issuance never updates or transfers consent grants. The subsequent
[partner/consent slice](partner-consent.md) now binds grants to an exact credential
ID and rechecks active status, partner, purpose, approved scope, revision and expiry
on every disclosure. Component tests check real grant denial after revocation and
replacement, in addition to the original temporary grant-reference probe.

A signature alone cannot enforce revocation. The protected online check combines
cryptographic validation with current database status. No partner disclosure or
offline partner verification API is added by this slice.

## Dedicated local Test keys

Only NODE_ENV=test plus TRUEID_CREDENTIAL_SIGNING_MODE=test and a
TRUEID_TEST_SIGNING_KEY_ID of the form test-UUIDv4 enables issuance. Development,
production, missing or partial signing settings fail closed. Blank settings keep
the rest of the service available and issuance unavailable.

One dedicated Test key was generated locally in ignored test-keys/ and configured
in ignored .env.test. Its private bytes were not printed. Normal .env retains
development mode and does not enable signing. Configure the Auth0 developer tenant
in the appropriate ignored environment file before authenticated API use.

To prepare another local Test environment, create .env.test from your existing
local settings without overwriting secrets. Set NODE_ENV=test and
TRUEID_CREDENTIAL_SIGNING_MODE=test, then run:

```powershell
npm run keys:test
# Set TRUEID_TEST_SIGNING_KEY_ID in .env.test to the printed public key ID.
npm run db:migrate
npm run build
npm run start:test
```

keys:test creates a new RSA-2048 PKCS8 Test key with exclusive file creation and
prints only its public ID. It rejects development/production settings and paths
outside the intended workspace directory. Keys are not generated at HTTP startup.
Keep older key files while an active credential may need an idempotent issuance
retry. Retain public verification keys for historical checks. Rotate by generating
a new key ID and changing the active Test ID; never reuse an ID for different key
material. There is no public key upload endpoint.

## Managed production boundary and deployment work

SigningKey/SigningKeys separate active and versioned signing. ManagedSigningKey
passes a SHA-256 digest and immutable remote key version to ManagedSigningBackend;
no private-key export or local production key operation exists. The expected
managed operation is RSASSA-PKCS1-v1_5 with SHA-256, consistent with
[JWS](https://www.rfc-editor.org/rfc/rfc7515.html) and managed signing APIs such as
[KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html).
No cloud vendor integration or production key has been configured or called.

Production remains rejected by this service. Deployment needs a chosen managed
KMS/HSM SDK adapter, workload identity/IAM, independently provisioned production
key versions, key rotation/retention/recovery policy, explicit production issuer/
audience and configuration, TLS/database deployment hardening and real integration
checks. Test signing is not a production fallback.

QoreID currently authenticates successfully (201) but denies the authorized Test
NIN request (403). That subscription/permission issue prevents an end-to-end
provider-backed issuance demonstration. The backend will not issue from that
unavailable outcome. No Live switch or verification bypass was introduced.

## Validation and changed files

The previous verification stage passed 54 tests plus typecheck/lint/build.
Final credential-stage results on 2026-10-14:

| Command/check | Exact result |
| --- | --- |
| npm run check | Exit 0; 74 passed, 0 failed, 0 skipped |
| npm run typecheck (within check) | Passed |
| npm run lint (within check) | Passed, zero warnings |
| npm run build (within check) | Passed |
| npm run keys:test | Exit 0; one dedicated local Test key created |
| Test key loader smoke | Exit 0; Test RSA key loaded, private material not printed |
| Key utility with development configuration | Expected exit 1; fixed test_key_generation_failed event, no extra key created |
| Credential/private-key isolation scan | No provider credentials outside ignored environment files; no private material outside ignored test-keys/ |

The separate QoreID Test integration remains **0 passed, 1 failed, exit 1**,
with authentication 201 and NIN 403. It was not retried after diagnosing permission
denial. Auth0 provider/mobile wiring, TCP PostgreSQL and production KMS/HSM checks
remain external work. No migrations were applied to a running TCP database here.

Tests use generated Test keys,
ephemeral technical principals and isolated PGlite databases, not application
seeds or real identities. No production KMS/HSM or TCP PostgreSQL result is claimed.

Credential changes are src/credentials/, src/verification/verified-outcome.service.ts
and verification.module.ts, src/audit/audit.service.ts, src/config/runtime-config.ts,
src/database/migrations.ts, migration 004_credentials.sql, safe HTTP/log route codes,
scripts/generate-test-signing-key.ts, package.json, .env.example,
tests/credential-signing.test.ts, tests/credentials.test.ts, migrations.test.ts and
http.test.ts, README.md, docs/modules.md, docs/stages.md and this guide. Ignored
.env.test and test-keys/ contain local Test configuration/material only.

The Expo, Next.js and Figma/Vite projects remain separate and unchanged. No changes
were deployed or published.
