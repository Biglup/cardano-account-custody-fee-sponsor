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
- `POST /v1/leases/:id/witness` with `{ transaction }` (the unsigned
  transaction as CBOR hex) checks the transaction against the policy below
  and answers 200 `{ witnessSet, leaseId }` with the sponsor's witness set
  as CBOR hex, to append with `applyVkeyWitnessSet` before submitting. The
  witness set holds the sponsor payment key's signature and nothing else;
  a signing that would produce more is refused like a policy failure. A
  lease issues one witness and is consumed by it; the same transaction
  presented again, even at the same moment, receives the same witness
  set. Failures: 422
  `invalid_transaction` with `rule` naming the first policy rule that
  failed and `detail` saying how, 404 `unknown_lease`, 410 `lease_expired`
  (also for a released lease), 409 `lease_consumed` for a different
  transaction on a consumed lease, 429 `quota_exceeded` when the key
  already obtained its hourly witnesses or when what its witnesses
  sponsored over the last day, plus this transaction, would pass its daily
  sponsored lovelace; the lease stays open after either.

- `POST /admin/keys` with `{ label, quotas? }` issues a client key, shown
  once and stored as its SHA-256 hash. Quotas: `openLeases`,
  `witnessesPerHour`, `sponsoredLovelacePerDay`.
- `GET /admin/pool` shows the pool counts, the reserve and every live UTxO.
- `POST /admin/pool/replenish` with optional `feeUtxoLovelace`,
  `feeUtxoCount`, `collateralLovelace` and `collateralCount` splits the
  reserve into pool UTxOs with a self transaction from the sponsor wallet,
  waits for confirmation and resyncs. Without counts it tops the pool up to
  the configured targets; counts are capped by what the reserve can fund.

## Transaction policy

The witness route signs only transactions that pass every rule, checked in
this order; the first failure is the one reported.

1. `well_formed`: the CBOR decodes as a Conway transaction of at most 16 KiB,
   every Plutus script witness carries a known language, and the body
   carries neither proposal procedures nor a treasury donation, which no
   account transaction needs and a proposal's guardrails script would
   otherwise run through unseen.
2. `uses_leased_fee_input`: the inputs include the leased fee UTxO and no
   other UTxO of the sponsor, that is, none the pool knows and none whose
   payment credential is the sponsor payment key, at a base, enterprise or
   pointer address. An input at an address whose payment credential cannot
   be read, such as a Byron address, cannot be classified and is refused.
3. `uses_leased_collateral`: the collateral is exactly the leased collateral
   UTxO, the collateral return pays the sponsor address and carries neither
   a datum nor a reference script, and total collateral is set and within
   what the UTxO holds.
4. `account_transaction`: an input is an account control UTxO (at an address
   paying to `ACCOUNT_SCRIPT_HASH`, holding a token of that policy), or the
   transaction creates an account: it mints exactly one token under the
   policy, registers exactly one script stake credential with its deposit,
   names the token after that credential and locks it in one output at an
   account address staked to that credential.
5. `sponsor_outflow_bounded`: the fee is at most `MAX_FEE_LOVELACE`; every
   output back to the sponsor is plain lovelace with neither a datum nor a
   reference script; what the fee input is drawn down by, after the change
   back to the sponsor, is exactly the fee plus, at creation only, the
   registration deposit and the control output's lovelace, and at most
   `MAX_SPONSORED_LOVELACE`.
6. `no_sponsor_value_elsewhere`: every output away from the sponsor and the
   account is covered by the non sponsor inputs and withdrawals.
7. `no_foreign_scripts`: every script input, mint policy, script credential
   of a certificate, withdrawal or vote, and attached script is the account
   script or the account's stake script: the stake script of a control UTxO
   the transaction spends, or at creation the one it registers. Outputs
   never widen this set.
8. `evaluates`: the provider resolves the inputs in one lookup and every
   one of them exists, the provider evaluates the transaction with the
   leased UTxOs supplied, and every redeemer declares at least the memory
   and steps the evaluation found it needs, so that a witnessed
   transaction can only fail in phase one, which spends no collateral.
9. `signers`: neither sponsor key is a required signer, and no withdrawal,
   certificate of any kind (stake, DRep, committee, pool operator, owner or
   reward account) or vote names a sponsor credential, so the sponsor's
   signature authorises nothing but paying.

Every decision is recorded in the audit table with the lease, the
transaction hash and the rule outcome; the transaction body is never stored.
A fee UTxO whose spend was witnessed is marked consumed at once and is never
leased again, since the signature is out there; the collateral UTxO stays
leasable because the policy never witnesses a transaction that could spend it.

A key's quotas are measured against the witnesses it was issued: the hourly
witness quota is checked before the policy runs, and the daily sponsored
lovelace quota against what the transaction would sponsor, once the policy
has established it. A witness set answered again for the same transaction
counts once.

## Commands

- `npm test` runs the test suite.
- `npm run lint` runs eslint.
- `npm run typecheck` runs the TypeScript compiler with no output.
- `npm run start` runs the service without the file watcher.
- `npm run replenish` splits the sponsor wallet into the pool of fee and collateral UTxOs.
