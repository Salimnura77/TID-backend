# First vertical slice: authenticated accounts

Implemented 2026-10-13. This slice creates/resumes private accounts after Auth0
authentication. Verification, credentials, partners, consent and disclosure are
outside its scope. Signing in is not an identity-verification or legal KYC decision.

## Design and storage

Auth provides a typed `AccessTokenVerifier`, an Auth0 implementation and a global
default-deny guard. Only explicit `@Public()` routes bypass authentication; the two
health routes are public. Users owns the repository and self-service account routes.
Ownership comes exclusively from the validated issuer/subject. There is no account
listing, arbitrary-ID read, password, code-exchange or demo-authentication endpoint.

Migration `002_account_identities.sql` adds only issuer, subject and the account FK.
The existing account table supplies random UUIDv4 IDs, status and UTC timestamps.
Unique issuer/subject and account constraints prevent duplicate bindings. Creation
and binding share one transaction: a losing candidate is removed, the existing
account is returned, and failures roll back without orphan records. Migration 001
is unchanged. Changing issuer creates a different binding; there is no email-based
merging or account linking.

No profile claims, contacts, passwords, tokens, documents or identity numbers are
stored. Internal IDs are returned only to the authenticated owner through the pinned
first-party native client. They are not partner identifiers. Pairwise mappings remain
for the partner slice.

## API

Both routes require exactly one Bearer access-token header and return `Cache-Control:
no-store`. Cookies, query tokens, demo keys and caller-selected IDs do not authenticate.

| Route | Result |
| --- | --- |
| `POST /api/v1/users/me` | 200, `{ account: { id, status, createdAt, updatedAt }, created }`; creates or resumes the caller. Body must be absent/empty JSON; query fields are rejected. |
| `GET /api/v1/users/me` | 200, `{ account: { id, status, createdAt, updatedAt } }`; caller's existing account only; query fields are rejected. |

Timestamps are UTC ISO strings. Disabled accounts return 403 on read and resume.
GET returns 404 before provisioning. Invalid/expired tokens return 401 with a fixed
Bearer challenge; missing `account:self` permission returns 403. Unconfigured or
unavailable authentication returns 503. Errors remain coded, redacted and correlated
with request IDs. Tokens, subjects and account IDs do not enter operational logs.

## Required external Auth0 development setup

1. Register a **Native public client** in your approved development tenant. Set exact
   mobile callback/logout URLs. Use Authorization Code with PKCE **S256** and disable
   implicit, password and client-credentials grants for this client. Refresh-token
   configuration is optional provider/mobile work.
2. Register the TrueID API audience with **RS256**, **RFC 9068** token dialect
   (`rfc9068_profile`, or its RBAC variant), and permission **`account:self`**.
   The default Auth0 token profile is not accepted.
3. The separate native app must use a maintained OIDC SDK with state/nonce/PKCE handling,
   request `openid account:self` plus the API audience, and send the API **access token**.
   ID tokens are rejected. No client secret belongs in native code.

| Backend variable | Requirement |
| --- | --- |
| `TRUEID_AUTH0_TENANT_MODE` | `sandbox` |
| `TRUEID_AUTH0_ISSUER` | Exact HTTPS issuer, trailing slash |
| `TRUEID_AUTH0_AUDIENCE` | TrueID API identifier |
| `TRUEID_AUTH0_MOBILE_CLIENT_ID` | Public Native application client ID |

Supply all four outside source control, or leave all blank. Partial settings fail
startup; blank settings keep health public and protected access closed. The backend
needs **no Auth0 client secret**. Any future confidential-client/provider secret must
come from deployment configuration or a secret manager. The sandbox label is an
operator declaration, not independent proof of tenant type; configure only your
approved development tenant. Production mode remains unsupported.

Validation pins issuer, audience, native client ID, RS256 and `at+jwt` type. It checks
required claims, time validity and permission, and rejects machine/delegated principals.
Only issuer/subject survives validation. Public JWKS comes from the configured issuer,
never token-controlled URLs, with timeout, redirect denial, cache and refresh cooldown.
No JWKS fetch occurs at startup or in the normal offline test suite.

Native grant/PKCE restrictions are enforced by Auth0 configuration; the backend cannot
infer the original PKCE transaction from a JWT. The existing mobile project is unchanged
and still needs this login wiring. Auth0 logout does not imply immediate JWT invalidation;
this slice has no logout/token-revocation endpoint. Users checks active account status
on every current account operation.

Sources: [Auth0 Native apps](https://auth0.com/docs/get-started/auth0-overview/create-applications/native-apps),
[PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce),
[token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles),
[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068).

## Commands and testing boundary

Use the existing local PostgreSQL workflow, supply ignored `.env`/process settings,
then run `npm run db:migrate` and `npm start`. Verification remains:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
# Sequential wrapper:
npm run check
```

Offline tests use ephemeral keys and opaque random technical principals to exercise
cryptographic rejection, guards and account isolation. No human profiles, runtime
users or production seed data are added. PGlite component databases are isolated and
closed; their scheduling does not replace PostgreSQL multi-connection race testing.

Real provider integration is separate and explicit:

```powershell
npm run test:auth0
```

Inject the four Auth0 settings, local `DATABASE_URL`, `NODE_ENV=test`, and
`TRUEID_RUN_AUTH0_SANDBOX_TESTS=true` into the test process. Also supply
`TRUEID_AUTH0_TEST_ACCESS_TOKEN_A` and `TRUEID_AUTH0_TEST_ACCESS_TOKEN_B` from two
different authorized development-tenant users logged in through the native PKCE flow.
Keep tokens out of source, examples, shell history, chat and logs. This command uses
real Auth0 JWKS validation with an isolated database, creates no Auth0 users, and
otherwise reports one skipped test. Normal `npm test` never runs this network test.
Provider setup/PKCE are not claimed verified by offline tests.
