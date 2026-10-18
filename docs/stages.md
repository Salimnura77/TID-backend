# MVP stages and acceptance gates

Work proceeds in order. Before each next stage, run relevant security/state tests,
typecheck, lint and build, then report changes and blockers. Future stages below
are plans, not implemented modules or available APIs.

| Stage | Scope | Required evidence before advancing |
| --- | --- | --- |
| 1 — Foundation | Separate NestJS service and domain module boundaries, validated local config, redacted operational logs, request IDs, URI versioning, safe HTTP boundary, PostgreSQL migration runner, minimal internal accounts, health, contract inventory | Configuration/error/log redaction; request correlation and isolation; versioned routing; absent business routes; account constraints; checksum/history denial; transactional rollback; checks passing |
| 2 — Authentication | Auth0 developer-tenant PKCE contract, access-token verifier, unique issuer/subject account mapping and self-service account routes are implemented; provider/mobile integration still needs external setup | Reject wrong issuer/audience/token use, expiry, bad signatures and disabled accounts; unique concurrent account provisioning; no demo-key bypass |
| 3a — Verification | QoreID Test NIN route behind an interface, minimal coded outcomes and atomic coded audit writes implemented; provider permission remains blocked by HTTP 403. Monnify NIN/BVN contract preparation is implemented offline, with runtime calls disabled pending approved test access | Redaction, failure/timeout, duplicate/concurrent submissions, account isolation and state constraints; Monnify request/match contracts and zero-egress runtime checks; no fake identity profiles or production seeds |
| 3b — Credentials | Test-only issuance, signature/status validation, revocation, rotation metadata and managed KMS/HSM signing boundary implemented; production integration remains external | Verified-only issuance; signature/tampering, expiry/revocation, account isolation, race and reverification tests; transactional audit writes; dedicated Test keys only in Test configuration |
| 4 — Registered partners and requests | Implemented: separate partner authentication, stored immutable random pairwise IDs, single-use user routing invitations, allowlisted fields, purpose and bounded expiry | Partner/account isolation; unknown/duplicate field denial; invitation replay denial; persisted pairwise constraints; no universal user IDs in partner payloads |
| 5 — Consent and disclosure | Implemented: explicit approve/decline, subset/expiry scope, revision-checked amendments and terminal revocation; each online read checks current credential/consent/partner/context in a transaction | Competing/stale decisions; zero values before approval; subset-only disclosure; wrong context denial; exact expiry; decline/revocation block subsequent reads |
| 6 — Pilot authentication and history | Implemented: endpoint-scoped partner credentials, operator-only rotation/revocation, credential lifecycle events and paginated owner-only consent history; mobile adapter and external integration remain future work | Permission/partner isolation; revoked keys; audit redaction and history authorization/pagination; compatibility migration. TCP PostgreSQL concurrency, mobile Auth0/PKCE, QoreID permissions and retention remain external checks |

CI and optional container release preparation are implemented in the
[CI/CD guide](ci-cd.md). They add delivery checks without enabling production or
activating additional identity providers. Application hosting is still undecided.

Accounts use random internal UUIDs. OIDC issuer/subject identifiers are private
authentication bindings; each registered partner gets a separate stable random
pairwise identifier. Pairwise mappings are persisted with database constraints so
credential replacement never silently changes the partner identifier.

Request and consent state transitions are enforced by domain services and database
constraints. Reads never activate consent. Approval requires an active credential
and a nonempty requested subset; decline is terminal. Revoked/expired grants cannot
be restored by changing credential status. A later verification needs a new grant.
Disclosure checks actual UTC time, including the exact expiry boundary, regardless
of background timers. The current requested slice supports repeat online reads
within an explicitly approved grant; amendments/revocation affect subsequent reads.
The separate fictional mobile pilot's per-use presentation contract is preserved in
that project and still needs an explicit adapter/design before connecting here.

Provider calls, signing and attribute retrieval stay behind typed interfaces. Development
verification must use approved provider sandbox/test facilities, retain coded outcomes
and store no unnecessary identity number or raw image. Do not add fictional identity
profiles or production seed data. A production signer requires managed KMS/HSM;
development signing keys must be ignored, labelled test-only and rejected in any
production configuration. Production configuration is not supported by Stage 1.

Audit payloads allow only event/actor codes, metadata references and UTC time. Do not
log or audit secrets, tokens, identity numbers, credential contents or disclosed
values. Audit protection and retention policy need separate decisions; a local
database does not establish tamper-proof evidence or compliance.

Revocation blocks future disclosures. It cannot recall attributes already received
by a partner. Any future offline credential verifier must understand this limit
and use an appropriate current-status mechanism.

Payments, wallets/transfers, USSD, a broad identity vault, government integrations
and production KYC claims stay excluded throughout. No real email/SMS or identity
provider calls are authorized by this plan. A connected integration requires an
explicit approved configuration before use.
