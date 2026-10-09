# Contributing

How to build, test and prove the fee sponsor service from a checkout.
[docs/verification.md](docs/verification.md) says what each check covers.
[docs/overview.md](docs/overview.md) explains what the service is.

## Requirements

- Node.js 22 or later. Continuous integration and the image use Node 22.
- A checkout of the
  [account custody contract](https://github.com/Biglup/cardano-account-custody-contract)
  next to this one, at `../cardano-account-custody-contract`, with its off
  chain library built. See [The sibling contract checkout](#the-sibling-contract-checkout).
- Docker, to build the image and run the smoke test.
- For the preprod proof: a Blockfrost preprod project id and test ADA.

## Layout

| Path | Holds |
| ---- | ----- |
| `src/` | The service, and the client adapter the package exports |
| `test/` | The test suite and its fixtures, under `test/support/` |
| `scripts/` | The preprod proof, the shared cometa loader and the container smoke test |
| `contract/plutus.json` | The blueprint of the contract build the service serves |
| `docs/` | The documentation and the generated evidence documents |

## Setting up

```sh
git clone https://github.com/Biglup/cardano-account-custody-contract.git
git clone https://github.com/Biglup/cardano-account-custody-fee-sponsor.git
(cd cardano-account-custody-contract/offchain && npm ci && npm run build)
cd cardano-account-custody-fee-sponsor
npm ci
cp .env.example .env
```

`.env.example` fills in `ACCOUNT_SCRIPT_HASH`, `KNOWN_LOGIC_HASHES`, `PORT`
and `DATABASE_PATH`. The service refuses to start until `.env` also sets
`SPONSOR_MNEMONIC`, `ADMIN_API_KEY`, and either
`BLOCKFROST_PREPROD_PROJECT_ID` or `PROVIDER_BASE_URL`.
[docs/operators/configuration.md](docs/operators/configuration.md) describes
every variable. Git ignores `.env`, and the Docker build context excludes it.

## Commands

| Command | Does | Needs the sibling checkout built |
| ------- | ---- | -------------------------------- |
| `npm test` | Runs the test suite | yes |
| `npm run lint` | Runs eslint | no |
| `npm run typecheck` | Type checks the service and its tests | yes |
| `npm run typecheck:scripts` | Type checks `scripts/` | yes |
| `npm run build` | Compiles the package to `dist/`, which is what another project imports the client adapter from | no |
| `npm run dev` | Runs the service with a file watcher | no |
| `npm run start` | Runs the service without the watcher | no |
| `npm run replenish` | Splits the reserve into pool UTxOs up to the configured targets, for a stopped service | no |
| `npm run preprod-e2e` | Runs the preprod proof | yes |
| `docker build -t <image> .` | Builds the container image | no |
| `scripts/smoke-image.sh <image>` | Runs the container smoke test against an image | no |

The service creates its database at `DATABASE_PATH` on first start, `./data/sponsor.sqlite`
by default, and binds it to the sponsor address. A later start with another
mnemonic is refused. Delete `./data` to start over with another wallet.

`docker compose up --build` runs the service from the checkout in a
container, as [docs/operators/deployment.md](docs/operators/deployment.md#running-with-compose)
describes.

## The sibling contract checkout

The contract's off chain library is a development dependency, linked with
`file:../cardano-account-custody-contract/offchain`. The test fixtures, both
type checks and the preprod proof load it. The service itself does not: it
reads the blueprint at `contract/plutus.json` and derives every account's
stake script from it.

The blueprint holds the three validators a network deploys:

| Validator | Hash |
| --------- | ---- |
| The account proxy, the value of `ACCOUNT_SCRIPT_HASH` | `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253` |
| The logic, applied to that proxy, the default of `KNOWN_LOGIC_HASHES` | `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a` |
| The stake validator, which each account applies to a device key and the proxy hash | parameterised, so no single hash |

### The CI pin

Continuous integration pins the contract at commit
`155b32b720ed3e34c183c323faea48f12ddaf510`. It checks that commit out as the
sibling checkout, builds its off chain library there, and compares
`contract/plutus.json` with that commit's `plutus.json` byte for byte.

Locally, the `file:` link uses the sibling checkout as it stands. To match
CI, check out the pinned commit and rebuild:

```sh
git -C ../cardano-account-custody-contract checkout 155b32b720ed3e34c183c323faea48f12ddaf510
(cd ../cardano-account-custody-contract/offchain && npm ci && npm run build)
```

[docs/verification.md](docs/verification.md#the-test-suite) says what the
tests check against the sibling checkout.

### Moving to another contract build

1. Change the pinned commit in `.github/workflows/ci.yml`.
2. Check out that commit as the sibling checkout and build its off chain
   library.
3. Copy its `plutus.json` to `contract/plutus.json`.
4. Update `CURRENT_LOGIC_HASH` in `src/config.ts`, `KNOWN_LOGIC_HASHES` in
   `.env.example`, and the expected hashes in `test/plutus.test.ts`.
5. Regenerate the lockfile when the off chain package's dependencies
   changed.
6. Run every command in the table above.

A deployment of the new build sets `ACCOUNT_SCRIPT_HASH` to its proxy, as
[docs/operators/runbook.md](docs/operators/runbook.md#the-contract-build-changes)
describes.

### Regenerating the lockfile

`package-lock.json` records the dependencies of the linked off chain package.
Regenerate it whenever that package changes its dependencies, with the
sibling checkout at the pinned commit:

```sh
npm install
npm ci
```

`npm install` rewrites the lockfile. `npm ci` then confirms it installs as
committed.

### One copy of cometa

cometa keeps its WebAssembly state per loaded copy. An object one copy
creates holds a pointer that another copy reads as garbage. The linked off
chain library resolves its own copy of cometa from the sibling checkout.
`scripts/shared-cometa.ts` points every resolution of cometa in the process
at this repository's copy. The test setup and the preprod proof load it
before the contract library.

## The container image

```sh
docker build -t sponsor-local .
scripts/smoke-image.sh sponsor-local
```

The build needs no sibling checkout. The smoke test needs Docker and curl,
pulls `node:22-bookworm-slim` for its stand-in provider, and reads the test
mnemonic from `test/support/service.ts`.
[docs/verification.md](docs/verification.md#the-container-smoke-test) lists
what it checks.

## The preprod proof

`npm run preprod-e2e` takes a custody account through its life on preprod:
a sponsored creation in fee mode, a deposit and a reserve deposit, an owner
spend from the reserve, a grant, an agent spend, the grant's revocation and
the sweep of the dead grant UTxO in collateral mode, and three refusals. It
spends test ADA and writes an evidence document under `docs/`. It needs the
sibling checkout built at the pinned commit.

It reads `.env` at the repository root. In both modes it needs
`SPONSOR_MNEMONIC`, `ACCOUNT_SCRIPT_HASH` and `BLOCKFROST_PREPROD_PROJECT_ID`.
It reads the chain and submits through the configured provider, except for
the stake registration lookups. Those query the hosted Blockfrost endpoint
directly, even when `PROVIDER_BASE_URL` is set. `KNOWN_LOGIC_HASHES` must name the logic the
linked contract library builds with.

Account 0 of `SPONSOR_MNEMONIC` is the funding wallet. The owner, the agent
and the recipient are fresh wallets of the same mnemonic: the first account
indexes from 10 whose stake credential is not registered and which hold
nothing. A key that created an account can never create another, so every
run takes new indexes.

### Local mode

Without `SPONSOR_SERVICE_URL`, the proof starts the service in its own
process, from `.env`, on a free port of `127.0.0.1`. It also needs
`ADMIN_API_KEY`. It uses the database at `DATABASE_PATH`. It issues itself a
client key. When fewer than 3 fee UTxOs are free or no collateral is shared,
it replenishes with 5 fee UTxOs and up to 2 collateral UTxOs. The funding
wallet is the sponsor wallet, so the deposit draws on the sponsor's reserve.
It writes `docs/preprod-evidence.md`, including the audit trail of the
collateral mode witnesses.

```sh
npm run preprod-e2e
```

### Hosted mode

With `SPONSOR_SERVICE_URL` and `SPONSOR_SERVICE_API_KEY` set, the proof runs
against a service already running elsewhere, as one of its clients. The URL
is the service's base URL, and the key a client key its operator issued.
Either variable alone is refused.

```sh
SPONSOR_SERVICE_URL=https://sponsor.example SPONSOR_SERVICE_API_KEY=<client key> npm run preprod-e2e
```

In this mode the proof:

- needs no `ADMIN_API_KEY`, calls no admin route, starts no service and
  never replenishes;
- reads the pool from `GET /health` before and after the run, and refuses to
  start when the service reports fewer than 2 free fee UTxOs or no shared
  collateral;
- takes the sponsor address from the service's lease and collateral answers,
  and refuses one that is the funding wallet's or one of its fresh wallets;
- pays the deposit of 70 tADA, 50 to the account and 20 into its reserve,
  from the funding wallet's UTxOs outside the pool sizes. The pool of a local
  deployment on the same mnemonic is never touched;
- writes `docs/preprod-hosted-evidence.md`, with the service's base URL, the
  sponsor address it reported and the pool as `GET /health` reported it, and
  no audit trail, which is the operator's to read.

### Against a local devnet

The contract repository's local devnet serves a Blockfrost compatible API at
`http://localhost:8080/api/v1` and ignores the project id. The service can
reach it through `PROVIDER_BASE_URL`. Read
[Reaching the chain](docs/operators/configuration.md#reaching-the-chain)
first for the network the service assumes.
