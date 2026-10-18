# Foundation module responsibilities and boundaries

The workspace already contains an isolated NestJS service, so it remains the
composition root. No second `backend/` package or shared frontend workspace is
introduced. Existing configuration, health, database and HTTP directories are
kept. Auth and Users implement the [account slice](account-auth.md); Verification
implements the [QoreID Test slice](qoreid-verification-plan.md). Audit writes its
coded lifecycle metadata. Credentials implements the [Test issuance slice](credentials.md).
Monnify has an [offline preparation boundary](monnify-preparation.md); selecting it
cannot send provider requests or persist a verification outcome.
Partners and Consent implement [requests and explicit consent](partner-consent.md).
The [pilot partner/audit stage](pilot-partner-audit.md) adds key lifecycle permissions
and owner-visible consent history.

## Responsibilities

| Module | Owns when business work is authorized | Boundary |
| --- | --- | --- |
| `AuthModule` | OIDC/OAuth access-token validation and authentication guards for mobile Authorization Code + PKCE | Authenticates callers; does not verify an identity, issue a TrueID credential or grant disclosure |
| `UsersModule` | Random private accounts, status and issuer/subject account bindings | Internal IDs stay private; no partner-facing identifier or raw identity vault |
| `VerificationModule` | Replaceable sandbox/authorized provider interfaces and minimal coded outcomes | No credential signing, partner access decision, email/SMS or unapproved provider call |
| `CredentialsModule` | Credential references/status, issuance/revocation and signing interfaces | Managed KMS/HSM for production; explicitly labelled development test keys; cannot imply consent |
| `PartnersModule` | Registered partner clients, client authentication and persisted stable pairwise identifiers | A different identifier per account/partner pair; a registered partner does not automatically gain attribute access |
| `ConsentModule` | Requests, purposes, expiry, explicit approval/decline, selected subsets, revocation and guarded disclosure | Checks authenticated ownership, current credential and consent before every disclosure; no automatic approval |
| `AuditModule` | Coded domain events and authenticated history | Metadata only, committed with domain actions; no values, secrets, tokens or credential contents; distinct from operational logs |
| `HealthModule` | Versioned liveness/readiness controllers | Public diagnostics only; readiness checks PostgreSQL and the expected migration history without returning connection details |
| `RuntimeConfigModule` | Validated immutable local settings | Global config provider; never exposes environment values through errors or logging |
| `LoggingModule` | Structured allowlisted operational events and isolated request context | Global logger/context providers; excludes raw requests, exceptions and identity values |
| `DatabaseModule` | PostgreSQL pool lifecycle and current schema readiness | Infrastructure connectivity, UTC and timeouts; no cross-domain disclosure or automatic migrations |

`AppModule` imports the modules. `http/` contains small shared configuration,
middleware and exception-filter functions rather than another module/provider layer.
Auth performs JWT validation through a typed verifier contract and global guard;
explicit partner routes instead require a registered partner's separate API key.
Users owns its private repository and two `/users/me` actions, and exports a narrow
active-account access service. Verification owns its private repository, provider
interface, QoreID adapter and authenticated submission/result routes. Audit exports
coded verification/credential/consent event writes using the caller's transaction.
Verification exports only a scoped verified-outcome gate to Credentials, which owns
its private reference/public-key repository and versioned signing interfaces.
Credentials exposes authenticated issuance, validation, status and revocation.
Credentials exports only a minimal active-result/expiry accessor to Consent.
Partners exports authentication, partner description and pairwise-ID access, with
operator-only credential lifecycle helpers. Audit exports scoped consent page reads
and fixed credential lifecycle event writes. The history HTTP route stays in Consent,
which resolves the owning account/request before reading any audit rows.
Consent coordinates these services using one transaction per action; its own
repository owns invitation/request/decision storage. User and partner controllers
use separate authenticated principals and never accept a partner-selected account ID.

## Dependency rules for subsequent work

Domain services should own their persistence access and expose narrow exported
interfaces to other modules. A module must not reach into another module's private
repository or query its tables directly. Define those interfaces alongside the
first actual use case; unused interfaces are not added to this foundation.

Auth validates an issuer/subject principal; Users resolves its private account binding.
Verification records
only minimal outcomes. Credentials consumes a verified outcome through an explicit
boundary. Consent coordinates user ownership, partner client scope and current
credential/consent status before disclosure. Partners owns pairwise mappings.
Domain actions append coded Audit records atomically with their state changes.
These boundaries implement the current online flow; mobile and provider integration
still require the external setup documented in their guides.

Infrastructure imports do not confer authorization. Access checks and consent must
be enforced in domain services on every disclosure, independently of mobile UI.
The existing minimal account migration stays in the infrastructure migration
directory; Users owns account behavior and lifecycle locking.

The Expo mobile app, Next.js site and Figma/Vite reference remain separate packages.
This backend does not import their runtime source. Its health route shape and
existing `/api/v1` prefix are preserved. The legacy phone-pairing API remains with
the existing fictional SQLite pilot and is not a fallback authentication route here.
