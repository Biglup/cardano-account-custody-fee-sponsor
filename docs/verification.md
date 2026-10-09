# Verification

How the service is verified: the test suite, continuous integration, the
container smoke test and the preprod proof. [CONTRIBUTING.md](../CONTRIBUTING.md)
says how to run each one.

## The test suite

`npm test` runs vitest over `test/**/*.test.ts`. The suite runs in process:
the HTTP application through supertest, an in memory sqlite database, and a
fake provider from `test/support/fake.ts`.

The fake provider holds UTxOs per address, reports protocol parameters close
to preprod's with a synthetic Plutus V3 cost model, and can be made to fail
a lookup or an evaluation. Its evaluation checks that every input is known
and that every script input has a redeemer. It does not run Plutus scripts.
Script execution, and with it phase two, is verified only on preprod.

The fixtures build their transactions with the contract's off chain library,
from the sibling checkout, over the blueprint the service ships.

| Suite | Verifies |
| ----- | -------- |
| `test/http/witness.test.ts` | The fee mode witness route and every policy rule in fee mode |
| `test/http/collateral.test.ts` | The collateral routes, every policy rule in collateral mode, and an upgrade with both logic versions known |
| `test/adversarial.test.ts` | Attacks from a client's side: draining the sponsor, replaying or reusing a lease, griefing the pool, and requests without a key or with a broken body |
| `test/witness.test.ts` | The witness service: the device bound, both quotas under concurrency, the check on the witness set, and lease races |
| `test/policy/parse.test.ts` | Transaction decoding and credential reading |
| `test/policy/script-data.test.ts` | The script data hash recomputation |
| `test/policy/stake-script.test.ts` | The stake script derivation and its cache |
| `test/pool/sync.test.ts` | Classification, discovery, gone, consumed, restore and retire transitions, and the shared collateral designation |
| `test/pool/leases.test.ts` | Lease creation, quotas, expiry and release |
| `test/pool/replenish.test.ts` | Split planning, input selection that never touches the pool, submission and confirmation |
| `test/http/admin.test.ts` | Key issuance, listing and disablement, the pool route and the audit route |
| `test/http/auth.test.ts`, `test/http/rate-limit.test.ts`, `test/http/errors.test.ts`, `test/http/app.test.ts`, `test/http/leases.test.ts` | Authentication, rate limits, error bodies, the health route, the body limit and the lease routes |
| `test/client/sponsor-wallet.test.ts` | The client adapter in both modes |
| `test/config.test.ts` | Every variable, its default and its refusal, and the proof's target selection |
| `test/provider.test.ts` | The endpoint choice, the absent project id header and the single slash join |
| `test/service.test.ts` | The startup refusals and state kept across a restart |
| `test/blueprint.test.ts`, `test/plutus.test.ts` | Blueprint loading, the refusal of another build, and the hashes of the shipped blueprint. When the sibling checkout is present, the shipped blueprint equals its build. |
| `test/logger.test.ts` | Log redaction |
| `test/db/migrations.test.ts`, `test/slots.test.ts`, `test/wallet.test.ts`, `test/index.test.ts` | The schema, the slot settings, the wallet derivation and wiping, and the package root's exports |

## Continuous integration

The workflow in `.github/workflows/ci.yml` runs on every pull request, on
every push to `main` and on every version tag.

1. It checks out the contract repository at the pinned commit as the sibling
   checkout and builds its off chain library.
2. It installs dependencies and compares `contract/plutus.json` with the
   pinned commit's blueprint byte for byte.
3. It runs `npm run lint`, `npm run typecheck`, `npm run typecheck:scripts`,
   `npm test` and `npm run build`.
4. It builds the image for `linux/amd64` and runs the container smoke test on
   it.
5. On `main` and on version tags only, it builds for `linux/amd64` and
   `linux/arm64` and publishes.

## The container smoke test

`scripts/smoke-image.sh <image>` runs the image as a deployment would, with a
throwaway configuration. It checks that:

- the blueprint the image ships hashes to an account proxy, read by the
  image's own copy of the library;
- against a stand-in provider that lists no UTxOs, `GET /health` answers 200
  with `"ok": true` within 30 seconds;
- the service runs as uid 60000 under tini;
- against a provider nothing listens at, the service exits with code 1 and
  its startup error;
- the image carries no `.env` file and no data directory.

The smoke test runs on the amd64 image only. The arm64 image is built from
the same Dockerfile and is not run.

## The preprod proof

`npm run preprod-e2e` takes a custody account through its life on preprod,
with the service as the only source of sponsor funds and collateral. It
writes one of two evidence documents.

- [preprod-hosted-evidence.md](preprod-hosted-evidence.md): a run on
  2026-10-09 against the hosted deployment at `https://sponsor-preprod.lw.iog.io`,
  as a client with no admin route, recording a sponsored creation, deposits,
  five collateral mode operations and three refusals.
- [preprod-evidence.md](preprod-evidence.md): a run on 2026-10-07 against a
  service the proof started itself, under a contract build with a single
  account validator in place of the proxy and the logic. It does not match
  the shipped blueprint.

## Not verified

[known-issues.md](security/known-issues.md) lists the residual risks, the
absence of an external audit among them.

- Phase two script execution is verified only through the preprod proof.
- No load or soak test exercises the service.
- The arm64 image is not run before it is published.
