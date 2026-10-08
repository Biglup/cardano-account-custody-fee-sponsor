# Cardano Account Custody Fee Sponsor

An HTTP service that holds one funded Cardano wallet and signs, as that
wallet, transactions other people build for the
[account custody contract](https://github.com/Biglup/cardano-account-custody-contract).
It leases fee UTxOs to clients, shares one collateral UTxO with every
transaction, checks each transaction against a fixed policy before
signing, and records every decision. The package also exports a client
adapter that implements cometa's `Wallet` interface over the API, so the
contract's own builders work unchanged.

## What it is for

A custody account is created by a device key whose owner may hold no
ADA. Creation costs a fee, a stake registration deposit and the lovelace
of the control UTxO, and it needs collateral because the account script
runs. The service lets a dApp pay for that: it leases one of its fee
UTxOs to the dApp, the dApp builds the creation on it, and the service
signs once the transaction draws nothing from the sponsor beyond the fee,
the deposit and the control UTxO.

Every later operation is paid by the account from its own UTxOs: an
owner operation from an account reserve, a deposit under a datum that
the owner alone can spend, or from the plain funds, and an agent spend,
which spends its grant UTxO and plain funds and references the control
UTxO without spending it, from the plain funds. An account reserve is
the contract's; the sponsor's reserve, the wallet's UTxOs outside the
pool, is another thing and is described under Pool. What the owner or an
agent still lacks is collateral, which only a wallet with ADA can
declare. For those transactions the service contributes its shared
collateral UTxO alone, signs the collateral declaration, and no sponsor
lovelace is spent.

Two modes follow from this, both served by the same policy:

- Fee mode: a leased fee UTxO pays for an account creation, drawn down
  by exactly the fee, the deposit and the control UTxO, and for nothing
  else: an operation on an existing account presented on this route is
  refused, since the account pays for it.
- Collateral mode: no sponsor UTxO is spent and no output pays the
  sponsor; the sponsor declares collateral and nothing else, for any
  operation on an existing account.

## Flows

### Sponsored creation, fee mode

```mermaid
sequenceDiagram
    participant D as dApp with SponsorWallet in fee mode
    participant S as Sponsor service
    participant C as Chain through the provider
    D->>S: POST /v1/leases
    S-->>D: 201 lease id, expiry, fee UTxO, shared collateral UTxO
    D->>D: createAccount builds on the leased fee UTxO and the shared collateral
    D->>S: POST /v1/leases/{id}/witness with the transaction
    S->>C: resolve the inputs, evaluate the scripts
    S->>S: apply the ten rules in fee mode
    S-->>D: 200 sponsor witness set, lease consumed
    D->>D: append the owner device signature
    D->>C: submit
```

### Account operation, collateral mode

```mermaid
sequenceDiagram
    participant W as Owner or agent wallet with SponsorWallet in collateral mode
    participant S as Sponsor service
    participant C as Chain through the provider
    W->>S: GET /v1/collateral
    S-->>W: 200 shared collateral UTxO, sponsor address, validity window
    W->>W: build the operation paid from the account, collateral from the sponsor
    W->>S: POST /v1/collateral/witness with the transaction
    S->>C: resolve the inputs, evaluate the scripts
    S->>S: apply the ten rules in collateral mode
    S-->>W: 200 sponsor witness set keyed by transaction hash
    W->>W: append the device or agent signature
    W->>C: submit
```

The service never submits a transaction; the client appends the sponsor
witness set with `applyVkeyWitnessSet` and submits through its provider.

## API

Every route except `GET /health` takes `Authorization: Bearer <key>`.
The `/v1` routes take a client key issued by the admin routes; the
`/admin` routes take `ADMIN_API_KEY`. Bodies are JSON and capped at
64 KiB. Every error is a JSON body `{ "error": "<code>" }` with an
optional `detail` sentence and, for a policy refusal, the `rule` that
failed.

Answers every route can give:

- 401 `unauthorized`: the key is missing, unknown or disabled, which a
  client route answers alike, or, on an admin route, not the admin key.
- 400 `invalid_request`: the body or query does not match the route, or
  the JSON does not parse. The detail names the first field at fault.
- 413 `payload_too_large`: the body is over 64 KiB.
- 429 `rate_limited`: the address or the key made its requests for the
  minute; see Quotas and rate limits.
- 404 `not_found`: no route matches.
- 500 `internal_error`: an error the service did not anticipate. The
  body carries nothing else.

### `GET /health`

Answers 200 with the network and the pool counts:

```json
{
  "ok": true,
  "network": "preprod",
  "pool": {
    "fee": { "free": 5, "leased": 0 },
    "collateral": { "shared": true, "spare": 1, "consumed": 0 }
  }
}
```

`shared` says whether a collateral UTxO is designated, `spare` how many
free collateral UTxOs stand behind it, and `consumed` how many shared
collateral UTxOs were ever taken by the chain.

### `POST /v1/leases`

Reserves the oldest free fee UTxO for the key for `LEASE_TTL_SECONDS`
and answers 201:

```json
{
  "leaseId": "b26ee940-dd6d-4456-b6c4-8336af3364ff",
  "expiresAt": "2026-10-07T13:40:45.753Z",
  "fee": { "txHash": "4c08...31f2", "index": 1, "address": "addr_test1...", "lovelace": 95485676 },
  "collateral": { "txHash": "1874...f2d0", "index": 1, "address": "addr_test1...", "lovelace": 5000000 },
  "sponsorAddress": "addr_test1...",
  "maxSponsoredLovelace": 6000000
}
```

`collateral` is the shared collateral UTxO as of the answer; it is not
reserved for the lease. A fee UTxO backs one open lease at a time.

- 429 `quota_exceeded`, detail `open_leases: at most N open leases per key`.
- 409 `no_utxo_available` when every fee UTxO is leased (the detail says
  how many and when the soonest lease expires), or when the pool holds
  no fee UTxO or no collateral UTxO yet and the sponsor's reserve could
  fund one by replenishing. The pool is resynced with the chain once before this
  answer.
- 503 `out_of_funds` when the pool holds no fee UTxO or no collateral
  UTxO and the reserve cannot fund a split of that size.

### `DELETE /v1/leases/:id`

Releases an open lease so its fee UTxO is free at once. Answers 200
`{ "leaseId": "...", "status": "released" }`, also for a lease already
released.

- 404 `unknown_lease` for an id the key does not hold.
- 410 `lease_expired` for a lease past its TTL.
- 409 `lease_consumed` for a lease that issued its witness.

### `POST /v1/leases/:id/witness`

Body `{ "transaction": "<unsigned transaction as CBOR hex>" }`. Checks
the transaction in fee mode, which serves an account creation only, and
answers 200:

```json
{ "witnessSet": "a10081825820...", "leaseId": "b26ee940-dd6d-4456-b6c4-8336af3364ff" }
```

`witnessSet` is a transaction witness set as CBOR hex holding the
sponsor payment key's signature and nothing else. A lease issues one
witness and is consumed by it; the same transaction presented again on
the consumed lease, even at the same moment, receives the same witness
set.

- 404 `unknown_lease`.
- 410 `lease_expired`, detail `Lease ... has expired` or `Lease ... was released`.
- 422 `invalid_transaction` with `rule` naming the first policy rule that
  failed and `detail` saying how; an operation on an existing account,
  which the fee route does not pay for, is refused here under
  `sponsor_outflow_bounded`. The lease stays open.
- 409 `lease_consumed` for a different transaction on a consumed lease.
- 429 `quota_exceeded`, detail `witnesses_per_hour: ...` or
  `sponsored_lovelace_per_day: ...`. The lease stays open.
- 409 `no_utxo_available` or 503 `out_of_funds` when the pool holds no
  collateral UTxO at the time of signing, as for a lease.

### `GET /v1/collateral`

Answers 200 with the shared collateral UTxO, for a client whose
transaction pays its own fee:

```json
{
  "txHash": "1874...f2d0",
  "index": 1,
  "address": "addr_test1...",
  "lovelace": 5000000,
  "sponsorAddress": "addr_test1...",
  "validitySeconds": 600
}
```

The collateral return must pay `sponsorAddress`, and the validity upper
bound may reach at most `validitySeconds` from the time of the witness
request.

- 409 `no_utxo_available` or 503 `out_of_funds` when the pool holds no
  collateral UTxO, as for a lease.

### `POST /v1/collateral/witness`

Body `{ "transaction": "<unsigned transaction as CBOR hex>" }`. Checks
the transaction in collateral mode and answers 200:

```json
{ "witnessSet": "a10081825820...", "txHash": "d886...4d03" }
```

No lease is involved. The witness is keyed by the transaction hash: the
same transaction presented again, by any key, receives the same witness
set.

- 422 `invalid_transaction` with `rule` and `detail`.
- 429 `quota_exceeded` under the key's witness quotas; a collateral
  witness sponsors zero lovelace, so the hourly witness quota is the one
  that applies.
- 409 `no_utxo_available` or 503 `out_of_funds` when the pool holds no
  collateral UTxO.

### `POST /admin/keys`

Body `{ "label": "<1 to 100 characters>", "quotas": { ... } }`, quotas
optional with any of `openLeases`, `witnessesPerHour` and
`sponsoredLovelacePerDay` as positive integers. Answers 201:

```json
{
  "apiKey": "<shown once>",
  "id": 1,
  "label": "my dapp",
  "quotas": { "openLeases": 5, "witnessesPerHour": 60, "sponsoredLovelacePerDay": 600000000 }
}
```

The key is stored as its SHA-256 hash.

### `GET /admin/keys`

Answers 200 with every key ever issued, oldest first, never the hash:

```json
{
  "keys": [
    { "id": 1, "label": "my dapp", "quotas": { "openLeases": 5, "witnessesPerHour": 60, "sponsoredLovelacePerDay": 600000000 }, "createdAt": "2026-10-07T12:00:00.000Z", "disabledAt": null }
  ]
}
```

### `DELETE /admin/keys/:id`

Disables the key, after which every request presenting it answers 401
`unauthorized`; its open leases run out by themselves. Answers 200
`{ "id": 1, "label": "my dapp" }`, also for a key already disabled, which
keeps the time it was first disabled at.

- 404 `not_found` for an id no key has; 400 `invalid_request` for an id
  that is not a number.

### `GET /admin/pool`

Closes any lease past its expiry, then answers 200 with the pool counts
as `/health` reports them, the reserve as of the last sync, the number
of open leases, the shared collateral UTxO with the time it was chosen,
or `null` when none is designated, and every free or leased UTxO:

```json
{
  "pool": { "fee": { "free": 5, "leased": 0 }, "collateral": { "shared": true, "spare": 1, "consumed": 0 } },
  "reserve": { "utxos": 2, "lovelace": "812345678", "syncedAt": "2026-10-07T13:36:25.530Z" },
  "leases": { "open": 0 },
  "sharedCollateral": { "txHash": "1874...f2d0", "index": 1, "lovelace": 5000000, "chosenAt": "2026-10-07T12:00:00.000Z" },
  "utxos": [
    { "txHash": "4c08...31f2", "index": 1, "lovelace": 95485676, "kind": "fee", "status": "free", "discoveredAt": "2026-10-07T12:00:00.000Z" }
  ]
}
```

### `GET /admin/audit?since=<ISO 8601>&limit=<n>`

Answers 200 `{ "entries": [ ... ] }` with the audit trail at or after
`since` (the beginning without it), oldest first, at most `limit`
entries (100 without it, 1000 at most). Each entry carries `id`, `ts`,
`apiKeyId` (absent for a decision no key asked for), `action`, `outcome`
and `detail`.

- 400 `invalid_request` for a `since` that is not an ISO 8601 time, a
  `limit` outside 1 to 1000, or an unknown query parameter.

### `POST /admin/pool/replenish`

Body optional with any of `feeUtxoLovelace`, `feeUtxoCount`,
`collateralLovelace` and `collateralCount`. Splits the reserve into pool
UTxOs with a self transaction from the sponsor wallet, waits up to 180
seconds for confirmation, resyncs and answers 200:

```json
{ "txId": "...", "feeOutputs": 5, "collateralOutputs": 1, "reserveLovelace": "312345678" }
```

`txId` is `null` and the counts zero when the pool is already at its
targets. Without counts a replenish tops the pool up to
`FEE_UTXO_COUNT` and `COLLATERAL_UTXO_COUNT`, counting free and leased
UTxOs; counts are capped by what the reserve can fund after a 3 ADA fee
margin, fee outputs first.

- 503 `out_of_funds` when the reserve cannot fund one output.
- 500 `internal_error` when the split is not confirmed in time.

## Transaction policy

The witness routes sign only a transaction that passes every rule, in
this order; the first failure is the one reported under `rule`. Two
rules ask something different in each mode and answer under another
name.

1. `well_formed`: the body is hex CBOR of at most 16 KiB that decodes as
   a Conway transaction, every Plutus script witness carries a known
   language, and the body carries neither proposal procedures nor a
   treasury donation.
2. `uses_leased_fee_input` in fee mode: the inputs include the leased
   fee UTxO and no other sponsor UTxO, where a sponsor UTxO is one the
   pool knows or one locked by the sponsor payment key at a base,
   enterprise or pointer address; an input whose payment credential
   cannot be read, such as one at a Byron address, is refused.
   `no_sponsor_inputs` in collateral mode: no input is a sponsor UTxO at
   all, the shared collateral spent as a regular input included.
3. `uses_shared_collateral`: the transaction is not flagged
   `is_valid = false`, the collateral inputs are exactly the shared
   collateral UTxO, which the lease named in fee mode and
   `GET /v1/collateral` in collateral mode, the collateral return pays
   the sponsor address and carries neither a datum nor a reference
   script, and total collateral is set and within what the UTxO holds.
   A transaction built on a collateral UTxO the pool has since replaced
   fails here.
4. `bounded_validity`: the body sets a validity upper bound later than
   the slot of the service's current time and no later than the slot of
   the lease expiry plus `VALIDITY_MARGIN_SECONDS` in fee mode, or of
   now plus `COLLATERAL_VALIDITY_SECONDS` in collateral mode; slots are
   compared as integers, with one second per slot from the network's
   Shelley start.
5. `account_transaction`: an input is an account control UTxO or grant
   UTxO, at an address paying to `ACCOUNT_SCRIPT_HASH` and staked to a
   script, holding a token of that policy named after that script alone,
   the 28 byte state NFT, or followed by a slot, the 32 byte grant token;
   every account whose token is spent has its control UTxO among the
   inputs or the reference inputs, as an agent spend references it, and
   every control UTxO among the reference inputs belongs to such an
   account. Otherwise the transaction creates an account: it mints
   exactly one token under the policy, named with the 28 bytes of a
   stake script hash, registers exactly one script stake credential with
   an explicit deposit, names the token after that credential and locks
   it in exactly one output at an account address staked to that
   credential. A token under another policy, whatever its name, and a
   token held at any other address count for nothing.
6. `sponsor_outflow_bounded` in fee mode: the transaction is an account
   creation, since a leased fee UTxO pays for nothing else and an
   operation on an existing account is refused whatever it draws; the
   fee is at most `MAX_FEE_LOVELACE`, exactly one output pays the sponsor
   address, the change, as plain lovelace with neither a datum nor a
   reference script, and the fee UTxO is drawn down, after that change,
   by exactly the fee, the registration deposit and the control output's
   lovelace, at most `MAX_SPONSORED_LOVELACE`. `sponsor_outflow_zero`
   in collateral mode: no output pays the sponsor payment key at any
   base, enterprise or pointer address, and no withdrawal draws from
   the sponsor's reward account; the fee is the account's and not
   capped.
7. `no_sponsor_value_elsewhere`: every output away from the sponsor and
   the account is covered, asset by asset, by the non sponsor inputs and
   the withdrawals that are not the sponsor's.
8. `no_foreign_scripts`: every script input, mint policy, script
   credential of a certificate, withdrawal or vote, and attached Plutus
   script is the account script or the account's stake script, that is,
   the stake script named by a control UTxO the transaction spends or
   references, which is the name of its state NFT, or the one it
   registers at creation, and the transaction carries no native script
   witness. A grant UTxO names no stake script by itself: the control
   UTxO an agent spend references does.
9. `evaluates`: the provider resolves every input and reference input in
   one lookup and all of them exist, the provider evaluates the
   transaction with the sponsor UTxOs it builds on supplied, and every
   redeemer declares at least the memory and steps the evaluation found
   it needs; a provider that refuses the lookup is reported here too.
10. `signers`: neither sponsor key is a required signer, no withdrawal
    draws from the sponsor's reward account, no certificate of any kind
    names a sponsor credential, and no voter is a sponsor credential; a
    signing that would produce any witness beyond the sponsor payment
    key's is refused under this rule as well.

| Rule | Fee mode | Collateral mode |
| ---- | -------- | --------------- |
| Sponsor inputs | `uses_leased_fee_input`: the leased fee UTxO and no other | `no_sponsor_inputs`: none |
| Collateral | `uses_shared_collateral`: the shared UTxO the lease named | `uses_shared_collateral`: the shared UTxO `GET /v1/collateral` names |
| Sponsor outflow | `sponsor_outflow_bounded`: a creation only, drawing exactly the fee, the deposit and the control UTxO | `sponsor_outflow_zero`: nothing in, nothing out |
| Validity bound | at most the lease expiry plus `VALIDITY_MARGIN_SECONDS` | at most now plus `COLLATERAL_VALIDITY_SECONDS` |

A witness in fee mode sponsors what the fee UTxO is drawn down by; a
witness in collateral mode sponsors zero lovelace. Both count against
the key's hourly witness quota; only the first adds to its daily
sponsored lovelace.

## Pool

On start and every 30 seconds the service lists the sponsor address
through the provider and classifies every UTxO holding only lovelace by
amount: within a tenth of `FEE_UTXO_LOVELACE` is a fee UTxO, within a
tenth of `COLLATERAL_UTXO_LOVELACE` a collateral UTxO, anything else,
and any UTxO carrying tokens, is the reserve. The reserve is never
leased and is what a replenish splits.

Fee UTxOs are exclusive: a lease marks one `leased` for the lease TTL,
a release or the expiry sweep, which runs every 30 seconds, frees it,
and a witness marks it `consumed`, since the signature is out there. A
consumed fee UTxO the chain still lists is freed again once the current
slot is more than 120 slots past the validity upper bound of every
witness issued on it, which the sync checks on each run; the margin
covers a clock a little ahead of the chain and a block the provider has
not shown yet. A fee UTxO that vanishes without a witness is marked
`gone` and freed if a rollback brings it back; a lease still open on a
vanished UTxO is closed.

One collateral UTxO is shared: the oldest free collateral UTxO at the
first sync, kept across syncs and restarts for as long as the chain
lists it. It is never leased, never selected as a fee UTxO, never spent
by a replenish whatever the reserve lists, refused as a regular input
by the policy, and never taken by a witnessed transaction that passed
the policy, since the evaluation rule leaves phase two nothing to fail
on. Should it vanish all the same, the sync marks it `consumed`,
records a `collateral_consumed` audit entry naming it and its
replacement, and designates the oldest free collateral UTxO in its
place; a transaction built on the old one fails the collateral rule and
is built again on the new one. A spare collateral UTxO that vanishes is
marked `gone` and restored when it reappears.

A pool UTxO the chain still lists but that lies outside every pool size
is retired, which happens when `FEE_UTXO_LOVELACE` or
`COLLATERAL_UTXO_LOVELACE` changes under a populated pool: a lease open
on it is closed as for a vanished UTxO, the retirement is recorded as a
`pool` audit entry, and the row is marked `retired`, a terminal status
that is never leased, never designated as collateral and never restored.
The UTxO is then the reserve's, and a replenish may split it. A replenish
never spends a UTxO the pool holds free, leased or consumed, whatever the
reserve lists.

## Quotas and rate limits

Each client key has three quotas, set at issuance and defaulting to
`openLeases` 5, `witnessesPerHour` 60 and `sponsoredLovelacePerDay`
600000000. The witness quotas count witnesses actually issued over the
last hour and the lovelace they sponsored over the last day; a witness
set answered again for the same transaction counts once. The hourly
quota is checked before the provider is called and the daily one once
the policy has established what the transaction sponsors; both are
checked again inside the database transaction that records the witness,
so requests in flight at once cannot pass them together.

Every request counts against its address's `IP_RATE_LIMIT_PER_MINUTE`
before anything reads it, and every `/v1` request against the key's
`KEY_RATE_LIMIT_PER_MINUTE` once the key authenticated. Past either the
answer is 429 `rate_limited` with `RateLimit` headers saying when the
window resets.

## Configuration

Every value is read from the environment at startup; a `.env` file in
the working directory is loaded into the environment first. Required:

| Variable | Shape |
| -------- | ----- |
| `BLOCKFROST_PREPROD_PROJECT_ID` | Blockfrost project id for preprod |
| `SPONSOR_MNEMONIC` | 12, 15, 18, 21 or 24 lowercase words; the sponsor wallet is account 0, payment index 0, stake index 0 |
| `ACCOUNT_SCRIPT_HASH` | the account validator's hash, 56 hex characters |
| `ADMIN_API_KEY` | the bearer token of the admin routes |

Optional, with defaults:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `8787` | listening port |
| `DATABASE_PATH` | `./data/sponsor.sqlite` | sqlite database file |
| `LEASE_TTL_SECONDS` | `600` | how long a lease holds a fee UTxO |
| `MAX_SPONSORED_LOVELACE` | `6000000` | the most a transaction may draw from the sponsor |
| `MAX_FEE_LOVELACE` | `2000000` | the largest fee a sponsored transaction may carry |
| `FEE_UTXO_LOVELACE` | `100000000` | size of a fee UTxO |
| `COLLATERAL_UTXO_LOVELACE` | `5000000` | size of a collateral UTxO |
| `FEE_UTXO_COUNT` | `10` | fee UTxOs a replenish tops the pool up to |
| `COLLATERAL_UTXO_COUNT` | `2` | collateral UTxOs a replenish tops the pool up to, one shared and the rest spare |
| `VALIDITY_MARGIN_SECONDS` | `120` | how far past the lease expiry a validity bound may reach |
| `COLLATERAL_VALIDITY_SECONDS` | `600` | how far from now a collateral mode bound may reach |
| `IP_RATE_LIMIT_PER_MINUTE` | `120` | requests per address per minute |
| `KEY_RATE_LIMIT_PER_MINUTE` | `60` | requests per key per minute |
| `TRUST_PROXY_HOPS` | `0` | reverse proxies in front of the service |

`FEE_UTXO_LOVELACE` and `COLLATERAL_UTXO_LOVELACE` must differ by more
than ten percent of the larger, or a UTxO of either size could not be
told from the other. The mnemonic reaches the process only through its
environment: the service reads it once, derives the wallet, empties it
from the configuration and removes `SPONSOR_MNEMONIC`,
`BLOCKFROST_PREPROD_PROJECT_ID` and `ADMIN_API_KEY` from the process
environment. A configuration error names the variable at fault and
never its value.

## Running

Requires Node 22.

1. Copy `.env.example` to `.env` and fill in the required variables.
2. Install dependencies with `npm ci`. The contract's off-chain library
   is a development dependency linked from a sibling checkout at
   `../cardano-account-custody-contract/offchain`, so the install needs
   that checkout present. Only `npm run typecheck:scripts` and the
   preprod proof use it, and both need it built there with `npm run
   build` in that directory; the service, its tests, `npm run lint` and
   `npm run typecheck` do not. The `file:` dependency and the continuous
   integration workflow are pinned to contract commit `b08a2e6`, the one
   whose builders the preprod proof builds on;
   `package-lock.json` must be regenerated whenever the contract's
   off-chain package changes its dependencies. The pinned commit is
   revision 2 of the validators, with each grant in its own grant UTxO,
   reserves, and the account validator at hash
   `6f275cca0cc4433e6a798d78a2db2934df60dc4fd989274a2d9bb434`, which is
   what `ACCOUNT_SCRIPT_HASH` must name.
3. Start the service with `npm run dev`, or `npm run start` without the
   file watcher.

The database schema is created on first start at `DATABASE_PATH`, and
the database is bound to the sponsor address derived from
`SPONSOR_MNEMONIC`: a later start whose mnemonic derives another address
is refused, since the pool, the leases and the witnesses describe one
wallet's UTxOs.

### Replenishing

`npm run replenish` splits the sponsor wallet's reserve into fee and
collateral UTxOs up to the configured targets and prints the transaction
id and the counts; it is for a stopped service, since it writes the pool
tables the service owns while it runs. `POST /admin/pool/replenish` is
the way to replenish while the service runs, with optional counts. Fund
the sponsor address, run a replenish, and `GET /health` reports the free
fee UTxOs and the shared collateral. A replenish spends the reserve only.

### Audit trail

Every decision is recorded with identifiers and amounts, never a
transaction body or a key, and read back through `GET /admin/audit`.
Actions and outcomes: `lease` with `created`, `released`, `expired`,
`consumed`, `quota_exceeded`, `no_utxo_available` and `out_of_funds`;
`witness` with `issued`, `reissued`, the name of the rule that refused
the transaction, `unknown_lease`, `lease_expired`, `lease_released`,
`lease_consumed`, `quota_exceeded`, `no_utxo_available` and
`out_of_funds`; `pool` with `restored`, `retired` and
`collateral_consumed`; `key` with `disabled`. A witness entry carries
the lease id or `mode: collateral`, the transaction hash, whether it was
a `creation` or an `operation`, the sponsored lovelace and the fee.

### Operator notes

- A shared collateral UTxO marked consumed stays consumed even when the
  chain lists it again after a rollback, since the pool never designates
  it a second time and never spends it. Reclaim it by spending it from
  the sponsor wallet by hand: spent alone, its change lands within a
  tenth of the collateral size and the next sync takes it up as a fresh
  free collateral UTxO; merged with other value, the next sync sees the
  change as reserve.
- The schema is defined in the initial migration only. A database
  created by an earlier development build is not migrated and must be
  deleted before starting.
- Changing `FEE_UTXO_LOVELACE` or `COLLATERAL_UTXO_LOVELACE` under a
  populated pool retires every pool UTxO of the old size on the next
  sync: open leases on them are closed, so a client building on one has
  its witness request refused and takes a new lease, and the UTxOs
  become reserve for the next replenish. A fee UTxO whose witnessed
  spend has not landed yet is retired all the same, and a replenish may
  then spend it ahead of that transaction; change the sizes while no
  witness is outstanding, or accept that such a transaction may be
  invalidated. Replenish after the change so the pool holds UTxOs of the
  new sizes. Retired rows stay retired if the sizes are reverted; a
  replenish, not a restore, puts UTxOs of the old size back in the pool.
- The service reads the chain's current slot off its own clock, so keep
  the clock disciplined with NTP. A clock ahead of the chain shortens
  the time a witnessed fee UTxO is held back; the 120 slot restore
  margin absorbs the usual drift.
- Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of
  proxies, and never more, so the address rate limited is the client's.
  With it unset, the first request that carries an `X-Forwarded-For`
  header makes the rate limiter print one warning to stderr about the
  untrusted header; the request is limited by its own address and the
  warning repeats no more.
- Terminate TLS in front of the service; keys travel as bearer tokens.
- Rotate `ADMIN_API_KEY` by changing the environment and restarting; it
  is not stored.
- Run one process against one database.

## Client adapter

`SponsorWallet`, exported from the package root along with
`SponsorError` and the API body types, implements cometa's `Wallet`
over the API. Options: `baseUrl`, `apiKey`, `provider`, `mode` (`fee`
by default, or `collateral`), and optionally `fetch` and `now`.

### Fee mode, as the `sponsor` of `createAccount`

```ts
import { SponsorWallet } from 'cardano-account-custody-fee-sponsor';

const sponsor = new SponsorWallet({ baseUrl: 'https://sponsor.example', apiKey, provider });
const tx = await createAccount({ owner, wallet: ownerWallet, sponsor, provider, state });
const witnesses = [...(await sponsor.signTransaction(tx, true)), ...(await ownerWallet.signTransaction(tx, true))];
const txId = await sponsor.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
```

- A lease is taken on first use and held until a witness consumes it,
  `release()` gives it up or it expires; the next use takes a new one.
  Calls that start while a lease is being taken wait for that one.
  `lease` is the one held.
- The wallet reports the sponsor address, the leased fee UTxO as its
  only spendable UTxO and the shared collateral UTxO as its only
  collateral, no reward addresses and no stake keys.
- `createTransactionBuilder()` returns a cometa builder preset with
  those, the provider as evaluator, both change outputs to the sponsor
  address and the validity upper bound at the lease expiry, so the
  contract's builders, which set no bound of their own, pass
  `bounded_validity` unchanged. A client that sets its own bound must
  keep it within the lease expiry plus `VALIDITY_MARGIN_SECONDS`.
- `signTransaction` posts to the lease's witness route and returns the
  sponsor's witness set; `submitTransaction` goes straight to the
  provider. Signing the transaction the last witness was issued for
  again goes back to the lease it consumed and receives the same
  witness set.
- A refusal is thrown as `SponsorError` with the HTTP `status`, the
  `code`, the `rule` when the code is `invalid_transaction` and the
  `detail`; an answer with no service error body, such as a proxy's, is
  thrown with code `unexpected_response`. A policy refusal leaves the
  lease open for a corrected transaction, except one under
  `uses_shared_collateral`, after which the lease is given back and the
  next use takes a lease naming the current collateral. A lease the
  service reports as `unknown_lease`, `lease_expired` or
  `lease_consumed` is dropped so the next use takes a new one.

The fee mode adapter is for `createAccount` only: the contract's
`createAccount` with a sponsor builds exactly what the policy accepts.
The contract library's owner builders take the same `sponsor` option,
and every one of them operates an existing account, which this service
always refuses under `sponsor_outflow_bounded`, whatever the transaction
draws: `spendWithDevice`, `rewriteState`, `addDevice`, `removeDevice`,
`revokeGrant`, `revokeAllGrants`, `withdrawRewards`, `delegateStake` and
`sweepGrant` with a sponsor are refused, and `issueGrant` with a sponsor
is always refused as well. Operations on an existing account take the
adapter in collateral mode instead.

### Collateral mode, as the `collateral` wallet of account operations

```ts
const collateral = new SponsorWallet({ baseUrl, apiKey, provider, mode: 'collateral' });
const tx = await spendWithDevice({ owner, wallet: ownerWallet, collateral, provider, outputs });
const witnesses = [...(await collateral.signTransaction(tx, true)), ...(await ownerWallet.signTransaction(tx, true))];
const txId = await collateral.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
```

- No lease is taken: the wallet reads `GET /v1/collateral` on first use
  and keeps it; `collateral` is what it holds, `getUnspentOutputs()`
  answers nothing and `getCollateral()` the shared UTxO.
- `createTransactionBuilder()` returns a builder with no spendable UTxO
  and a coin selector that adds none, the shared UTxO as collateral with
  its return to the sponsor address, the provider as evaluator, and the
  validity upper bound at now plus `validitySeconds` less a margin of
  60 seconds, or half the window when that is smaller. The change
  address is the caller's to set; the contract's builders set it to the
  account and add the account's own UTxOs as inputs: the control UTxO
  and a reserve or funds on the owner path, the grant UTxO and funds on
  the agent path, which references the control UTxO instead. A grant
  spend's validity upper bound is the builder's `validUntilSlot`, which
  must stay within the window as well.
- `signTransaction` posts to `POST /v1/collateral/witness`; the same
  transaction signed again receives the same witness set. A refusal
  under `uses_shared_collateral` drops the collateral held so the next
  builder reads the current one. `release()` forgets it.

Every owner operation, stake operation and grant spend of the contract
library accepts the `collateral` option, so an owner or agent wallet
that holds no ADA can operate the account with the service behind the
collateral alone.

### One copy of cometa

The consumer must await `Cometa.ready()` on the copy of cometa the
adapter runs on before the adapter is first used; the adapter does not
load the WebAssembly module itself. Any cometa object passed into the
adapter's builder, such as a script or a reward address, must come from
that same copy. cometa keeps its WebAssembly state per loaded copy, and an
object of one copy holds a pointer that another copy reads as garbage. A
registry install of this package and of cometa dedupes them into one
copy; a `file:` link does not, and a consumer linked that way must point
every resolution of cometa at one copy, as `scripts/shared-cometa.ts`
does for the preprod proof.

## Preprod proof

[docs/preprod-evidence.md](docs/preprod-evidence.md) records a full run
on preprod: a sponsored creation in fee mode for an owner holding no
ADA, a deposit and a reserve deposit, then in collateral mode with the
account paying its fees an owner spend paid from the reserve, a grant
issued into its own grant UTxO, an agent spend that references the
control UTxO, the grant's revocation and the sweep of the dead grant
UTxO, an agent spend over the remaining cap refused under `evaluates`,
a creation paying sponsor value to a third party refused under
`sponsor_outflow_bounded`, and the reuse of a consumed lease refused as
`lease_consumed`, with every transaction, who paid what and every
refusal body.

`npm run preprod-e2e` reruns it and rewrites the document. It spends
test ADA from the sponsor wallet: it starts the service in this process
from `.env` on a free local port, issues a client key, replenishes with
5 fee UTxOs and up to 2 collateral UTxOs when fewer than 3 fee UTxOs are
free or no collateral is shared, and uses account indexes of the sponsor
mnemonic from 10 upwards whose stake credential is not registered and
which hold nothing as the owner, the agent and the recipient. It needs
the sibling contract checkout built and loads `scripts/shared-cometa.ts`
first.

## Security

[docs/security.md](docs/security.md) covers who can call what, what an
attacker can try against each defence, what the sponsor can lose at
most, and how to run the service so that none of it is undone by its
surroundings.

## Commands

- `npm test` runs the test suite.
- `npm run lint` runs eslint.
- `npm run typecheck` runs the TypeScript compiler with no output over the service and its tests.
- `npm run typecheck:scripts` does the same over `scripts`, which needs the sibling contract checkout built.
- `npm run build` compiles the package to `dist`, which is what another project imports the client adapter from.
- `npm run dev` runs the service with a file watcher; `npm run start` without.
- `npm run replenish` splits the sponsor wallet into pool UTxOs up to the configured targets.
- `npm run preprod-e2e` runs the preprod proof.

## Limitations

- One sponsor wallet, derived from one mnemonic, at one address.
- State lives in one sqlite database; the lease and quota guarantees
  rest on its transactions, so one process serves one database and
  there is no horizontal scaling without a shared database.
- Preprod only: the network and the Blockfrost endpoint are fixed to
  preprod, and mainnet is refused in code, since the service carries the
  slot settings of preprod alone.
- The service has not been audited.

## License

Apache-2.0. See [LICENSE](LICENSE).
