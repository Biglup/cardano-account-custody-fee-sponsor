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
2. Install dependencies: `npm install`. The contract's off-chain library
   is a development dependency linked from a sibling checkout at
   `../cardano-account-custody-contract/offchain`, so the install needs
   that checkout present. Only the preprod proof under `scripts` uses it;
   the service, its tests, `npm run typecheck` and `npm run lint` stand
   without it being built, and `npm run typecheck:scripts` needs it built
   there with `npm run build`.
3. Start the service: `npm run dev`

`GET /health` answers once the service is up. On start the service lists
the sponsor address, classifies every UTxO it finds by lovelace (fee sized,
collateral sized, or reserve), designates the oldest collateral UTxO as the
one collateral every transaction declares, and keeps the pool in step with
the chain every 30 seconds.

The service reads the chain's current slot off its own clock, so keep the
clock disciplined with NTP; a clock ahead of the chain shortens the time a
witnessed fee UTxO is held back, and the restore margin described under
the transaction policy is what absorbs the usual drift.

The database schema is defined in the initial migration and created on
first start at `DATABASE_PATH`. A database created by an earlier
development build is not migrated and must be deleted before starting.

Optional tunables, all with defaults: `LEASE_TTL_SECONDS`,
`MAX_SPONSORED_LOVELACE`, `MAX_FEE_LOVELACE`, `FEE_UTXO_LOVELACE`,
`COLLATERAL_UTXO_LOVELACE`, `FEE_UTXO_COUNT`, `COLLATERAL_UTXO_COUNT`,
`VALIDITY_MARGIN_SECONDS`, `COLLATERAL_VALIDITY_SECONDS`,
`IP_RATE_LIMIT_PER_MINUTE`, `KEY_RATE_LIMIT_PER_MINUTE` and
`TRUST_PROXY_HOPS`.

The threat model, what the sponsor can lose and how to run the service
safely are in [docs/security.md](docs/security.md).

## API

Every route except `/health` takes `Authorization: Bearer <key>`. Client
keys are issued by the admin routes, which take the `ADMIN_API_KEY`.
Every request counts against its address's `IP_RATE_LIMIT_PER_MINUTE`,
and every client route against the key's `KEY_RATE_LIMIT_PER_MINUTE`;
past either the answer is 429 `rate_limited`, with `RateLimit` headers
saying when the window resets. Behind a reverse proxy, set
`TRUST_PROXY_HOPS` to the number of proxies so the address limited is
the client's and not the proxy's. With it unset, a request that carries
an `X-Forwarded-For` header makes the rate limiter print a one time
warning to stderr about the untrusted header; the request is limited by
its own address and the warning is harmless.

- `POST /v1/leases` reserves one fee UTxO for the lease TTL and answers
  201 with the lease id, the expiry, the fee UTxO, the shared collateral
  UTxO as of the answer, the sponsor address and the most lovelace a
  transaction may draw from the sponsor. A fee UTxO backs one lease at a
  time; collateral is never leased, the one shared UTxO backs every
  transaction at once. Failures: 409 `no_utxo_available` when every fee
  UTxO is leased (the detail says how many and when the soonest lease
  expires) or when the pool holds no fee or collateral UTxO yet while the
  reserve could be split, 503 `out_of_funds` when the pool holds no fee or
  collateral UTxO and the reserve cannot fund a split, 429 `quota_exceeded`
  when the key already holds its open lease quota.
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
  sponsored lovelace; the lease stays open after either. 409
  `no_utxo_available` or 503 `out_of_funds` when the pool holds no
  collateral UTxO at the time of signing, as for a lease.
- `GET /v1/collateral` answers 200 `{ txHash, index, address, lovelace,
  sponsorAddress, validitySeconds }`: the shared collateral UTxO, the
  sponsor address its return must pay, and `COLLATERAL_VALIDITY_SECONDS`,
  for a client whose transaction pays its own fee and needs no lease.
  Failures: 409 `no_utxo_available` or 503 `out_of_funds` as for a lease,
  when the pool holds no collateral UTxO.
- `POST /v1/collateral/witness` with `{ transaction }` checks the
  transaction against the policy in collateral mode, described below, and
  answers 200 `{ witnessSet, txHash }` with the sponsor's witness set over
  it, which holds the sponsor payment key's signature and nothing else. No
  lease is involved: the same transaction presented again, by any key,
  receives the same witness set, and a transaction that spends any sponsor
  UTxO is refused. Failures: 422 `invalid_transaction` with `rule` and
  `detail`, 429 `quota_exceeded` under the hourly witness quota, 409
  `no_utxo_available` or 503 `out_of_funds` when the pool holds no
  collateral UTxO, as for a lease.
- `POST /admin/keys` with `{ label, quotas? }` issues a client key, shown
  once and stored as its SHA-256 hash. Quotas: `openLeases`,
  `witnessesPerHour`, `sponsoredLovelacePerDay`.
- `GET /admin/pool` shows the pool counts, the reserve, the shared
  collateral UTxO with the time it was chosen, and every live UTxO.
- `GET /admin/audit?since=<ISO 8601>&limit=<n>` lists the audit trail from
  `since` (the beginning without it), oldest first, at most `limit`
  entries (100 without it, 1000 at most), each with its id, time, key id,
  action, outcome and detail.
- `POST /admin/pool/replenish` with optional `feeUtxoLovelace`,
  `feeUtxoCount`, `collateralLovelace` and `collateralCount` splits the
  reserve into pool UTxOs with a self transaction from the sponsor wallet,
  waits for confirmation and resyncs. Without counts it tops the pool up to
  the configured targets; counts are capped by what the reserve can fund.

## Transaction policy

The witness routes sign only transactions that pass every rule, checked in
this order; the first failure is the one reported. The rules are the same
in both modes; three of them ask something different of a transaction in
collateral mode and answer under another name, as listed after the rules.

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
3. `uses_leased_collateral`: the collateral is exactly the shared collateral
   UTxO the lease named, the collateral return pays the sponsor address and
   carries neither a datum nor a reference script, and total collateral is
   set and within what the UTxO holds. A transaction flagged
   `is_valid = false`, which declares its scripts fail and hands the
   collateral to the ledger, is refused under this rule. A transaction
   built on a collateral UTxO the pool has since replaced is refused here
   too, and the client builds again on the one a new lease names.
4. `bounded_validity`: the body sets a validity upper bound
   (`invalid_hereafter`) whose slot is later than the slot of the service's
   current time and no later than the slot of the lease expiry plus
   `VALIDITY_MARGIN_SECONDS`, so that a witnessed transaction that is never
   submitted cannot keep its fee UTxO out of the pool for longer than that.
   Slots are compared as numbers, whatever their size, and the expiry slot
   is read as one second per slot from the network's Shelley start, which
   is what every network has had since. A bound already in the past is
   refused too, since no node would accept the transaction.
5. `account_transaction`: an input is an account control UTxO (at an address
   paying to `ACCOUNT_SCRIPT_HASH`, holding a token of that policy), or the
   transaction creates an account: it mints exactly one token under the
   policy, registers exactly one script stake credential with its deposit,
   names the token after that credential and locks it in one output at an
   account address staked to that credential.
6. `sponsor_outflow_bounded`: the fee is at most `MAX_FEE_LOVELACE`; every
   output back to the sponsor is plain lovelace with neither a datum nor a
   reference script; what the fee input is drawn down by, after the change
   back to the sponsor, is exactly the fee plus, at creation only, the
   registration deposit and the control output's lovelace, and at most
   `MAX_SPONSORED_LOVELACE`.
7. `no_sponsor_value_elsewhere`: every output away from the sponsor and the
   account is covered by the non sponsor inputs and withdrawals.
8. `no_foreign_scripts`: every script input, mint policy, script credential
   of a certificate, withdrawal or vote, and attached script is the account
   script or the account's stake script: the stake script of a control UTxO
   the transaction spends, or at creation the one it registers. Outputs
   never widen this set.
9. `evaluates`: the provider resolves the inputs in one lookup and every
   one of them exists, the provider evaluates the transaction with the
   sponsor UTxOs it builds on supplied, and every redeemer declares at
   least the memory and steps the evaluation found it needs, so that a
   witnessed transaction can only fail in phase one, which spends no
   collateral.
10. `signers`: neither sponsor key is a required signer, and no withdrawal,
    certificate of any kind (stake, DRep, committee, pool operator, owner or
    reward account) or vote names a sponsor credential, so the sponsor's
    signature authorises nothing but paying.

### Collateral mode

An owner or agent operation pays its own fee from the account and needs
nothing from the sponsor but collateral. The collateral witness route
serves it under the same rules, with these differences:

- `no_sponsor_inputs` takes the place of `uses_leased_fee_input`: no input
  is the sponsor's, that is, none the pool knows and none whose payment
  credential is the sponsor payment key at any address form, and an input
  whose payment credential cannot be read is refused as before. The shared
  collateral UTxO spent as a regular input is refused here.
- `uses_shared_collateral` takes the place of `uses_leased_collateral` and
  asks the same of the collateral, against the UTxO `GET /v1/collateral`
  names.
- `bounded_validity` measures the bound against now plus
  `COLLATERAL_VALIDITY_SECONDS` instead of the lease expiry plus the
  margin, so that a signed transaction cannot linger.
- `account_transaction` is unchanged: a control input of an account, or a
  creation whose fee someone else pays, is acceptable.
- `sponsor_outflow_zero` takes the place of `sponsor_outflow_bounded`: no
  output pays the sponsor payment key, at any address, and no sponsor value
  enters the transaction, neither through an input nor through a
  withdrawal from the sponsor's reward account. The fee is the account's
  and is not capped.
- `no_sponsor_value_elsewhere`, `no_foreign_scripts`, `evaluates`, with the
  shared collateral as the UTxO supplied, and `signers` are unchanged.

A witness in collateral mode sponsors zero lovelace: it counts against the
key's hourly witness quota and adds nothing to its daily sponsored
lovelace.

### Records and the pool

Every decision is recorded in the audit table with the lease or the
collateral mode, the transaction hash and the rule outcome, as is every
refusal for a lease that is unknown, expired, released or consumed, every
key refused under a quota, every lease taken, released, expired or closed
by the pool sync, and every collateral UTxO consumed; the transaction body
is never stored. A fee UTxO whose spend was witnessed is marked consumed
at once, since the signature is out there, and is leased again only once
the chain still lists it more than 120 slots after the validity upper
bound of every witness issued on it, which the pool sync checks on every
run; the margin covers a clock a little ahead of the chain and a block the
provider has not shown yet. A witness issued in collateral mode spends no
sponsor UTxO, so nothing is held back for it.

The shared collateral UTxO is never leased, never selected as a fee UTxO,
never spent by a replenish and never consumed by a witnessed transaction
that passed the policy, since the evaluation rule leaves phase two nothing
to fail on; it is the oldest free collateral UTxO at the first sync and
stays the same one across syncs and restarts for as long as the chain
lists it. Should it vanish all the same, the pool sync marks it consumed,
records a `collateral_consumed` entry naming the UTxO and its replacement,
and designates the oldest free collateral UTxO in its place; a transaction
built on the old one is refused under the collateral rule and is built
again on the new one. `GET /health` reports whether a collateral UTxO is
shared, how many spare ones stand ready and how many were consumed, and a
replenish creates `COLLATERAL_UTXO_COUNT` of them, so one is always in
reserve.

A key's quotas are measured against the witnesses it was issued, in either
mode: the hourly witness quota is checked before the policy runs, and the
daily sponsored lovelace quota against what the transaction would sponsor,
once the policy has established it. Both are checked once more in the step
that records the witness, so that requests in flight at the same time
cannot pass them together. A witness set answered again for the same
transaction counts once.

## Client adapter

`SponsorWallet`, exported from the package root, is a cometa wallet over
the API, to pass as the `sponsor` of the account contract's builders:

```ts
import { SponsorWallet } from 'cardano-account-custody-fee-sponsor';

const sponsor = new SponsorWallet({ baseUrl: 'https://sponsor.example', apiKey, provider });
const tx = await createAccount({ owner, wallet: ownerWallet, sponsor, provider, state });
const witnesses = [...(await sponsor.signTransaction(tx, true)), ...(await ownerWallet.signTransaction(tx, true))];
const txId = await sponsor.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
```

- The `mode` option picks what the sponsor contributes: `fee`, the
  default, leases a fee UTxO the sponsor pays from; `collateral` has the
  sponsor contribute the shared collateral alone, for a transaction the
  account pays for.
- In fee mode a lease is taken on first use and held until a witness
  consumes it, `release()` gives it up or it expires; the next use takes a
  new one. `lease` is the one held, with its UTxOs and its expiry.
- What the wallet reports as its own is what the lease grants: the sponsor
  address, the leased fee UTxO as its only spendable UTxO and the shared
  collateral UTxO as its only collateral.
- `createTransactionBuilder()` returns a cometa builder preset with those,
  the provider as its evaluator, both change outputs to the sponsor and
  the validity upper bound at the lease expiry, so the contract's
  builders, which set no bound of their own, pass `bounded_validity`
  unchanged. A client that sets its own bound must keep it within the
  lease expiry plus `VALIDITY_MARGIN_SECONDS`.
- `signTransaction` posts the transaction to the witness route of the
  mode and returns the sponsor's witness set; the client appends its own
  signatures and submits, and `submitTransaction` goes straight to the
  provider, since the service never submits. A refusal is thrown as
  `SponsorError` with the HTTP `status`, the error `code`, the policy
  `rule` when the code is `invalid_transaction`, and the `detail`. A
  policy refusal leaves the lease open for a corrected transaction; a
  lease the service reports as unknown, expired or consumed is dropped so
  the next use takes a new one. Signing the transaction the last witness
  was issued for again, as a client does after losing the answer, goes
  back to the lease it consumed and receives the same witness set rather
  than taking a new lease the policy would then refuse.
- In collateral mode the wallet takes no lease: it reads the shared
  collateral through `GET /v1/collateral` on first use and keeps it,
  `collateral` is what it holds, `getUnspentOutputs()` answers nothing,
  since the account funds the transaction, and `getCollateral()` answers
  the shared UTxO. `createTransactionBuilder()` returns a builder with no
  spendable UTxO and a coin selector that adds none, the shared UTxO as
  the collateral with its return to the sponsor, the provider as the
  evaluator, and the validity upper bound at now plus `validitySeconds`
  less a minute; the client adds the account's control and fund UTxOs as
  inputs and sets the change address to the account, since an output to
  the sponsor is refused in this mode. `signTransaction` posts to the
  collateral witness route; the same transaction signed again receives
  the same witness set, and a refusal saying the shared collateral was
  replaced drops the one held so the next builder reads the current one.
  `release()` forgets what the wallet holds in either mode, waiting for a
  lease still being taken and giving that one back.
- Any cometa object passed into the adapter's builder, such as a script
  or a reward address, must come from the same copy of cometa the adapter
  runs on. cometa keeps its WebAssembly state per loaded copy, and an
  object of one copy holds a pointer that another copy reads as garbage.
  A registry install of the package and of cometa dedupes them into one
  copy; a `file:` link does not, and a consumer linked that way must
  point every resolution of cometa at one copy, as `scripts/shared-cometa.ts`
  does for the preprod proof.

The contract's `createAccount` with a sponsor builds exactly what the
policy accepts at creation. Its owner operations with a sponsor let the
sponsor pay the control output's growth, when the state outgrows the
lovelace the control UTxO holds, and receive withdrawn rewards as change,
both of which the policy refuses under `sponsor_outflow_bounded`, which
requires an operation to draw exactly the fee from the sponsor. So
`withdrawRewards` with a sponsor is refused whenever it withdraws
anything, since the withdrawal lands in the sponsor's change, and `addDevice`,
`issueGrant` and `rewriteState` with a sponsor are refused once the
larger state raises the control output's minimum lovelace above what it
holds; the other owner operations with a sponsor pass while the control
output keeps its lovelace. Owner operations the service will not pay for
are built paid from the account's own funds, with the sponsor contributing
the collateral through the adapter in collateral mode and the device
wallet only signing.

## Preprod proof

`npm run preprod-e2e` runs the whole loop against preprod and spends
test ADA from the sponsor wallet: it starts the service in this process
from `.env` on a free local port, issues a client key, replenishes the
pool when fewer than three fee UTxOs are free, creates a custody account
for a fresh owner wallet that holds no ADA (an account index of the
sponsor mnemonic from 10 upwards whose stake credential is not
registered) through the contract's `createAccount` with `SponsorWallet`
as the sponsor, checks the control UTxO, the registration and the
amounts on chain, has the service refuse a creation that also pays
sponsor value to a third party and the reuse of the consumed lease, and
writes [docs/preprod-evidence.md](docs/preprod-evidence.md).

The script builds through the contract's off-chain library, linked from
the sibling checkout described under Running, which must be built there
first. It loads `scripts/shared-cometa.ts` before the library so that
both use this repository's copy of cometa, since the link does not
dedupe the two copies and the reward address the contract's builder
registers would otherwise be read by the wrong one.

## Commands

- `npm test` runs the test suite.
- `npm run lint` runs eslint.
- `npm run typecheck` runs the TypeScript compiler with no output over the service and its tests.
- `npm run typecheck:scripts` does the same over `scripts`, which needs the sibling contract checkout built.
- `npm run start` runs the service without the file watcher.
- `npm run build` compiles the package to `dist`, which is what another project imports the client adapter from.
- `npm run replenish` splits the sponsor wallet into the pool of fee UTxOs and the collateral UTxOs, one of which is shared.
- `npm run preprod-e2e` runs the preprod proof described above.
