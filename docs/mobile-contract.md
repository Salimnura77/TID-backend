# Existing mobile contract and migration boundary

Inspected on 2026-10-12 before implementation. Source locations are relative to
the separate `../TID app/mobile` project. This file records behavior to preserve
when later stages introduce an authenticated mobile adapter; it does not introduce
those routes into Stage 1.

## Domain and wire behavior

`src/domain/model.ts`, `src/services/contracts.ts`, `src/services/backend.ts` and
`src/services/testingContract.ts` define:

| Concept | Existing contract |
| --- | --- |
| Attribute keys | `fullName`, `over18`, `nationality`, `verification` |
| Purposes | `onboarding`, `reuse` |
| Requested duration | `minute`, `day`, `week` |
| Request/consent states | `pending`, `approved`, `declined`, `revoked`, `expired` |
| Access without a usable credential | `unavailable` |
| Credential states | `unverified`, `verified`, `review`, `unable`, `revoked` |
| Time fields | UTC epoch milliseconds, integer/nonnegative |
| Review | Request ID, purpose, requested/approved keys, duration, creation/decision/expiry metadata |
| Decision | `{ decision: "approve", attributes: [...] }` or `{ decision: "decline" }` |
| Partner result | `requestId`, `status`, `attributes`, `expiresAt`, optional labelled demo digital pass |
| Error handling | `error.code`; safe user messages and retry/disconnect controls |

Approval must select a nonempty subset of requested keys. A decline shares nothing.
Status reads return `attributes: {}`, including after approval. The user must
explicitly present approved attributes before each disclosure. Presentation is
short-lived and single-use; exchange rechecks consent, credential status, partner,
purpose, expiry and approved keys. Revocation and reverification deny future use.
Tokens and returned attribute values remain in phone memory; they are not stored
in AsyncStorage. Connected errors do not fall back to client-side approval.
Offline demo and connected state remain separate.

## Existing fictional pilot endpoints

The mobile adapter uses `/api/v1/testing` with an `X-TrueID-Demo-Session` header:

| Method | Suffix | Behavior |
| --- | --- | --- |
| POST | `/pair` | One-time host pairing code; `sample`/`new` fictional profile |
| GET | `/state` | Metadata snapshot with `demo: true`, `serverTime`, credential, requests and events |
| POST | `/credential/status` | Simulate verification |
| POST | `/requests` | Create fictional Kora request; `kind: "digital-pass"` |
| POST | `/requests/:id/decision` | Explicit approval subset or decline |
| POST | `/consents/:id/revoke` | Immediate access revocation |
| GET | `/requests/:id/status` | Status with no disclosed values |
| POST | `/requests/:id/present` | User-triggered fictional presentation and partner exchange |
| POST | `/reset` | Reset only that tester's fictional state |
| POST | `/disconnect` | End phone session |

The legacy server also has separate `/user` and `/partner` demo routes with
different master credentials. Its `TID-DEMO-001` credential reference is display
metadata, never an authentication secret. `DEMO-NIN-001` is a fictional fixture.

## New backend boundary

Only `/api/v1/health` preserves an existing response in Stage 1. No legacy pairing
or master-key authentication is copied into the new service. The current mobile
adapter is therefore **not yet compatible** with this service and keeps using its
existing pilot unchanged.

Stage 2 will use an approved OIDC issuer's Authorization Code + PKCE mobile flow.
The API validates access tokens and resolves the account from trusted issuer/subject
claims; it must not accept a submitted account ID as proof of ownership. Partner
authentication is separate. Internal UUIDs and issuer subjects must never become
partner-facing identifiers.

Later DTOs/adapters should preserve the attribute names, approval interaction,
coded status behavior and epoch-millisecond mobile timestamps where feasible.
Storage uses UTC `timestamptz`. Public partner responses must use a stable identifier
unique to each account/partner pair and avoid shared credential identifiers that
enable correlation. Signed credential formats and authenticated API shapes need
explicit versioning rather than silently replacing the legacy testing contract.

No mobile files were changed. OIDC client setup and mobile login changes are future
work, not something an informational website sign-in page currently provides.
