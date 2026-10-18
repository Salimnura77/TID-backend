# Monnify NIN/BVN integration preparation

Prepared on 2026-10-16. The user explicitly chose **provider calls disabled**
because no approved Monnify identity-verification test facility is configured.
This stage prepares contracts and safe outcome mapping, not an active Sandbox or
production integration. No Monnify verification or authentication call was made.

## Official contracts and scope

Monnify's [customer verification guide](https://developers.monnify.com/docs/verification-api/verifying-your-customers)
states that NIN and BVN identity verification are Live-only. Some examples use the
Sandbox URL; those examples are not evidence of Sandbox availability. Its
[official support article](https://support.monnify.com/topics/other-monnify-services-259/know-your-customer-monnify-verification-services-611)
also says these services are unavailable in Sandbox.

The prepared client uses the documented [authentication contract](https://developers.monnify.com/docs/collections/quickstart)
and only these verification request schemas:

| Operation | Documented request |
| --- | --- |
| Authenticate | `POST /api/v1/auth/login`, Basic authentication from API key and secret; no identity payload |
| NIN | `POST /api/v1/vas/nin-verification`, exactly `{ nin }` |
| BVN information match | `POST /api/v1/vas/bvn-details-match`, exactly `{ bvn, name, dateOfBirth, mobileNo }` |

BVN DOB uses `DD-Mmm-YYYY`; the documented local mobile number format is eleven
digits beginning with zero. No bank account, document image, payment, transfer,
wallet, USSD or virtual-account integration is added. The client does not require
a payment contract code. It sends no internal account, partner or credential ID.

The existing NIN submission's first/last names are used locally to compare the
returned NIN record; the prepared outbound payload contains only the NIN. Names match only after
NFC, case and whitespace normalization, without fuzzy matching. Exact matching
names plus the expected NIN and a boolean `ninInformationMatch=true` are required
for a verified contract classification. Partial/transposed names require review;
other mismatches deny verification. A valid number alone is insufficient.

BVN requires a boolean `bvnInformationMatch=true` and consistent echoed BVN,
name, DOB and mobile number. `requestSuccessful=true`/HTTP 200 alone never means
verified. Missing, malformed or unknown evidence fails closed. The implementation
follows the current guide's boolean-match response shape; it does not guess how to
interpret legacy or different response formats. Both routes return only the
existing coded `VerificationResult`, never raw fields or provider references.
This is a data-match policy, not proof of liveness or physical identity ownership.

## Runtime selection and configuration

```dotenv
# Existing behavior stays the default:
TRUEID_VERIFICATION_PROVIDER=qoreid
# The only permitted Monnify mode at this stage:
TRUEID_MONNIFY_MODE=disabled
```

To select the prepared, unavailable Monnify boundary in your own ignored local
configuration, set `TRUEID_VERIFICATION_PROVIDER=monnify`. This does **not** enable
Monnify calls, fall back to QoreID, or make the sample payloads valid Sandbox data.
Unknown selectors fail startup. The factory rejects unknown values even when
called directly with an invalid injected configuration.

The runtime `MonnifyProvider` has `available=false`, no credentials, no transport,
and no activation flag. Authenticated submissions with a valid existing DTO return
503 `verification_unavailable` before an attempt, audit event or credential can be
created. Authentication and global validation still apply. Disabled/unconfigured
providers now fail before the QoreID-specific Test-input check.

`TRUEID_MONNIFY_MODE=live`, `production`, `sandbox` or `contract-test` is rejected.
Any nonempty `TRUEID_MONNIFY_*` setting other than `MODE=disabled` also fails startup,
including keys, secrets, arbitrary hosts and activation flags. Do not configure
Monnify credentials yet; there is no approved facility to use them with. No actual
provider credentials were requested, read, generated or written to source. Unit
tests create ephemeral credential markers only. Existing ignored environment files
were not read or edited.

The legacy NIN HTTP DTO, endpoint shape and QoreID adapter stay intact. There is
no BVN submission endpoint, Monnify database row, provider-labelled fake verified
record or new migration in this preparation stage. An active BVN/API/storage
extension is intentionally deferred until an approved provider test contract exists.
The account, credential, partner, consent, audit-history and mobile projects retain
their existing behavior; Test signing remains restricted to dedicated Test configuration.

## Offline contract client and redaction

`MonnifyContractClient` is separate from Nest injection. It has **no default fetch
implementation** and requires an explicitly injected `contract-test` transport and
ephemeral Test-shaped credentials. Unit tests supply only in-process responses;
the client is never constructed by the runtime provider. Its fixed example URLs
use `sandbox.monnify.com`; it has no production host or configurable URL.

Each contract exercise authenticates without token caching, then sends only the
route's minimum fields. Input snapshots prevent caller mutation while awaiting
authentication. An overall five-second deadline and caller cancellation abort the
request signal, including a transport that never settles. Redirects are rejected;
JSON reads are bounded to 64 KiB, including streamed bodies. Invalid content types,
tokens, expiry metadata and response envelopes fail closed. Errors expose only
fixed outcome/reason codes; no arbitrary exception, provider response or input is
logged, audited or returned. True private client fields prevent accidental JSON
serialization of its ephemeral credentials.

Official documentation examples appear only in in-memory contract tests; they
are not Monnify-approved test identities, application accounts or runtime seeds.
The HTTP boundary test uses QoreID's published Test input and confirms that
Monnify selection creates no attempt, credential or verification audit row and
performs zero outgoing fetch calls even with a configured QoreID alternative.

## Commands, changed files and checks

No package dependency or lockfile change is needed. Existing commands remain:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
# All of the above sequentially:
npm run check
# Focused offline checks after test compilation:
npm run build:test
node --test dist-test/tests/monnify-contract.test.js dist-test/tests/monnify-runtime.test.js dist-test/tests/qoreid-provider.test.js
```

Changed files:

- `src/verification/monnify-provider.ts` and `create-verification-provider.ts`:
  unavailable runtime boundary and strict provider selection.
- `src/verification/monnify-contract.ts`, `monnify-contract-client.ts`: typed NIN/BVN
  inputs, documented request preparation, minimal match results and bounded error handling.
- `src/config/runtime-config.ts`, `.env.example`: validated selector and disabled-only
  Monnify configuration; existing configured QoreID behavior remains the default.
- `src/verification/verification.module.ts`, `verification.service.ts`: provider
  factory wiring and availability check before provider-specific Test input policy.
- `tests/monnify-contract.test.ts`, `tests/monnify-runtime.test.ts`: offline contract,
  redaction, mismatch, failure, cancellation, configuration and no-egress tests.
- `README.md`, `docs/modules.md`, `docs/stages.md` and this guide: scope, setup,
  commands, limitations and results.

Validation on 2026-10-16:

| Command | Exact result |
| --- | --- |
| Baseline `npm run check` | Exit 0; 100 tests passed, 0 failed, 0 skipped; typecheck, lint and build passed |
| `npm run build:test` | Exit 0 |
| Focused `node --test` command above | Exit 0; 17 tests passed, 0 failed, 0 skipped |
| Final `npm run check` | Exit 0; 111 tests passed, 0 failed, 0 skipped; typecheck, lint and build passed |

The final test run took 90,756.5287 ms. External QoreID/Auth0 integration commands
were not run for this stage, and no migration or TCP PostgreSQL check was needed
for the unchanged schema. No Monnify provider call was made. Nothing was deployed
or published.

## Activation work still required

Obtain Monnify's written test-access authorization and authoritative test request/
response specification for these identity routes. Configure only the resulting
approved Test credentials through deployment configuration or a secret manager,
without sharing secrets in chat. Activation will require a separate reviewed
transport/configuration change, route-specific HTTP DTOs and accurate persisted
provider/route/environment metadata. Validate both positive and negative cases
against that facility before permitting issuance from Monnify outcomes.

Production activation is not authorized by this work. It would additionally require
explicit production configuration and approved production credentials, production
signing and operational deployment work. The current backend rejects production
mode and offers no live Monnify path. No local contract result establishes a real
identity verification or a partner's legal KYC compliance.
