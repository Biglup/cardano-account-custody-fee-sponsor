# cardano-account-custody-fee-sponsor

Cardano fee sponsor service for the account custody model.

## Running

Requires Node 22.

1. Copy `.env.example` to `.env` and fill in every variable:
   - `BLOCKFROST_PREPROD_PROJECT_ID`
   - `SPONSOR_MNEMONIC`
   - `ACCOUNT_SCRIPT_HASH`
   - `ADMIN_API_KEY`
   - `PORT`
   - `DATABASE_PATH`
2. Install dependencies: `npm install`
3. Start the service: `npm run dev`

`GET /health` answers once the service is up. On start the service lists
the sponsor address, classifies every UTxO it finds by lovelace (fee sized,
collateral sized, or reserve) and keeps the pool in step with the chain
every 30 seconds.

Optional tunables, all with defaults: `LEASE_TTL_SECONDS`,
`MAX_SPONSORED_LOVELACE`, `MAX_FEE_LOVELACE`, `COLLATERAL_SHARING`,
`FEE_UTXO_LOVELACE`, `COLLATERAL_UTXO_LOVELACE`, `FEE_UTXO_COUNT` and
`COLLATERAL_UTXO_COUNT`.

## API

Every route except `/health` takes `Authorization: Bearer <key>`. Client
keys are issued by the admin routes, which take the `ADMIN_API_KEY`.

- `POST /v1/leases` reserves one fee UTxO and one collateral UTxO for the
  lease TTL and answers 201 with the lease id, the expiry, both UTxOs, the
  sponsor address and the most lovelace a transaction may draw from the
  sponsor. A fee UTxO backs one lease at a time; a collateral UTxO may back
  several, up to `COLLATERAL_SHARING`. Failures: 409 `no_utxo_available`
  when every fee UTxO is leased (the detail says how many and when the
  soonest lease expires), 503 `out_of_funds` when the pool holds no fee
  UTxO and the reserve cannot fund a split, 429 `quota_exceeded` when the
  key already holds its open lease quota.
- `DELETE /v1/leases/:id` releases a lease early; 404 `unknown_lease` for a
  lease the key does not hold.
- `POST /admin/keys` with `{ label, quotas? }` issues a client key, shown
  once and stored as its SHA-256 hash. Quotas: `openLeases`,
  `witnessesPerHour`, `sponsoredLovelacePerDay`.
- `GET /admin/pool` shows the pool counts, the reserve and every live UTxO.
- `POST /admin/pool/replenish` with optional `feeUtxoLovelace`,
  `feeUtxoCount`, `collateralLovelace` and `collateralCount` splits the
  reserve into pool UTxOs with a self transaction from the sponsor wallet,
  waits for confirmation and resyncs. Without counts it tops the pool up to
  the configured targets; counts are capped by what the reserve can fund.

## Commands

- `npm test` runs the test suite.
- `npm run lint` runs eslint.
- `npm run typecheck` runs the TypeScript compiler with no output.
- `npm run start` runs the service without the file watcher.
- `npm run replenish` splits the sponsor wallet into the pool of fee and collateral UTxOs.
