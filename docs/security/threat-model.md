# Threat model

The service holds a funded Cardano wallet and signs transactions that other
people build. This document names what it protects, whom it trusts, what an
attacker can try and which defence stops each attempt. The defences against
hostile transactions are the [policy](../policy.md) rules, POL-1 to POL-12.
This document links to them and does not restate them.
[known-issues.md](known-issues.md) lists the risks that remain.

The account custody contract has its own
[security review](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/security-review.md).
This document covers the fee sponsor only.

## Assets

| Asset | Where it lives | What it is worth to an attacker |
| ----- | -------------- | ------------------------------- |
| The [pool](../glossary.md#pool) | Fee UTxOs and collateral UTxOs at the sponsor address | Lovelace a hostile transaction could draw |
| The [reserve](../glossary.md#reserve) | The other UTxOs at the sponsor address | Lovelace, spendable only with the sponsor key |
| The sponsor mnemonic | The process environment at startup | Every UTxO at the sponsor address |
| The admin key | The service's memory and the operator's secret store | Client keys, the audit trail, and replenishing from the reserve |
| Client keys | The clients. The database holds only their hashes. | The holder's quotas |
| The availability of the pool | The database and the chain | Service to every other client |

## Trust assumptions

- The [provider](../glossary.md#provider) answers truthfully and currently.
  See [Trusting the provider](#trusting-the-provider).
- The host and its clock are the operator's. See
  [Clock](../operators/deployment.md#clock).
- A reverse proxy terminates TLS, and `TRUST_PROXY_HOPS` matches the proxies
  in front of the service. See [deployment.md](../operators/deployment.md#exposing-the-service).
- The operator lists in `KNOWN_LOGIC_HASHES` only logic versions it has read.
- The contract's scripts enforce the account's own rules. The service decides
  what it pays for and lends collateral to, not what an account may do.

## Who can call what

| Caller | Can | Cannot |
| ------ | --- | ------ |
| Anyone | `GET /health`: the network and the pool counts | Anything that identifies a client or a UTxO |
| A [client key](../glossary.md#client-key) | Take and release its own leases, obtain witnesses on them, read the shared collateral, obtain collateral witnesses | See or use another key's lease, which answers as unknown |
| The [admin key](../glossary.md#admin-key) | Issue, list and disable client keys, read the pool and the audit trail, replenish | Obtain a witness for a client transaction |

No route returns the mnemonic, a private key, a client key after issuance, or
a transaction body. A missing, unknown or disabled client key answers the
same 401, so a caller learns nothing about which keys exist.

## Draining the sponsor

A client holding a lease can build any transaction around the leased fee UTxO
and the shared collateral. Any client can present any transaction to the
collateral route. The witness covers the whole body, so each attempt below
targets what the sponsor's signature would authorize.

| Attempt | Stopped by |
| ------- | ---------- |
| Spend another sponsor UTxO: another fee UTxO, the shared collateral as a regular input, the reserve, or anything the sponsor payment key locks | [POL-2](../policy.md#pol-2-sponsor-inputs) |
| Declare other collateral, keep the collateral return, or flag the transaction as failing to forfeit the collateral | [POL-3](../policy.md#pol-3-shared-collateral) |
| Have the sponsor pay for a transaction that is not a custody account's, for a lookalike token, or for a creation registering a stake script of the client's own | [POL-5](../policy.md#pol-5-account-transaction) |
| Have the sponsor serve an account under rules nobody vetted | [POL-6](../policy.md#pol-6-known-logic) |
| Draw more from the fee UTxO than a creation costs, pay for an operation on the fee route, or scatter the change into the reserve | [POL-7](../policy.md#pol-7-sponsor-outflow) |
| Pay sponsor value to a third party | [POL-8](../policy.md#pol-8-no-sponsor-value-elsewhere) |
| Run a script outside the account, or admit a logic anywhere but where the account runs it | [POL-9](../policy.md#pol-9-no-foreign-scripts) |
| Make the sponsor signature authorize a required signer, a withdrawal, a certificate or a vote | [POL-12](../policy.md#pol-12-signers) |
| Smuggle a sponsor UTxO, a control UTxO or a logic in through a reference input | [POL-5](../policy.md#pol-5-account-transaction) and [POL-9](../policy.md#pol-9-no-foreign-scripts): a reference input is never read as an input |

The witness set that leaves the service holds the sponsor payment key's
signature alone, which [POL-12](../policy.md#pol-12-signers) checks after
signing.

## Spending the collateral

The ledger takes collateral only when a script fails in phase two.
[POL-11](../policy.md#pol-11-evaluates) refuses a transaction that does not
evaluate through the provider within its declared budgets. A witnessed
transaction can then fail only in phase one, which takes no collateral. This
is why one collateral UTxO backs every transaction at once, without a lease.

Evaluation alone does not bind what the chain runs. The sponsor signs the
body, and the scripts run on the witness set, which no signature covers.
Anyone can replace the redeemers and the datums after signing without
invalidating the sponsor's signature. What binds them is the script data
hash, which sits in the signed body and which the ledger checks in phase one.

An evaluation endpoint judges the witness set in front of it and ignores the
hash in the body. The attack:

1. The client builds a body committing to script data it never shows, with
   budgets too small for it.
2. It attaches honest redeemers, which evaluate, and obtains the signature.
3. It swaps in the script data the body committed to. Phase one passes,
   since the attached data matches the hash. Phase two runs scripts nobody
   evaluated, they exceed their budgets, and the collateral is forfeit.

[POL-10](../policy.md#pol-10-script-data-hash) closes this before evaluation.
What [POL-11](../policy.md#pol-11-evaluates) evaluates is then the only
script data the signed body accepts.

In collateral mode the shared collateral is the only sponsor value a
transaction touches. Should the reasoning above ever fail, the loss is the
shared collateral, at most `COLLATERAL_UTXO_LOVELACE`, and it happens once.
The pool sync marks it consumed, records it, designates a spare and reports
the count on `/health`, as [pool.md](../operators/pool.md#collateral-utxos)
describes. A transaction signed against the consumed UTxO cannot land.

## Trusting the provider

The service reads and evaluates the chain through one
[provider](../glossary.md#provider) and trusts its answers. Three defences
rest on it:

- [POL-11](../policy.md#pol-11-evaluates) takes the provider's evaluation as
  the phase two verdict;
- [POL-10](../policy.md#pol-10-script-data-hash) takes the provider's cost
  models as the chain's;
- the rules that classify inputs take the provider's view of what each input
  holds and whom it pays.

A provider that lies or serves a stale view can cost the sponsor the shared
collateral, by reporting an evaluation the chain then fails, and the
lovelace of one creation, by fabricating the view of the inputs the outflow
check compares. Both are bounded. Only the collateral loss shows, as a
`pool` `collateral_consumed` audit entry and in the pool counts on
`/health`. A creation paid on a fabricated view of its inputs is an ordinary
`witness` `issued` entry. The provider cannot obtain a signature over a
transaction the service did not inspect. The structural rules read the
transaction itself, and the witness set is checked before it leaves.

A provider that does not answer stops the service from witnessing. See
[runbook.md](../operators/runbook.md#the-provider-is-unreachable).

Point the service only at an endpoint trusted as much as the wallet it
holds.

## Replaying a witness

A lease issues one witness and is consumed by it. The same transaction
presented again receives the same witness set and counts once against the
quotas. A different transaction on a consumed lease answers 409
`lease_consumed`.

A collateral witness is keyed by the transaction hash. The same transaction
presented again, by any key, receives the same witness set, which authorizes
nothing the first one did not. It is recorded once, however many requests
present it at the same time.

A witness is a signature over one transaction body. It cannot be moved to
another transaction.

## Freezing the pool

A client can try to deny the pool to others.

- Leases it never uses: each lasts `LEASE_TTL_SECONDS` at most, and a key
  holds at most `openLeases` at a time.
- Witnesses it never submits: each holds its fee UTxO until the witness
  lapses. [POL-4](../policy.md#pol-4-bounded-validity) bounds the validity of
  every witnessed transaction. [pool.md](../operators/pool.md#restore-after-the-validity-lapses)
  gives the resulting hold time, and [pool.md](../operators/pool.md#sizing)
  how to size `witnessesPerHour` so that no single key can hold the whole
  pool. The daily sponsored lovelace quota ends the attempt in any case,
  since every fee mode witness counts against it whether or not it lands.
- The collateral route holds nothing. The shared collateral is not reserved
  for any client, and an unsubmitted collateral witness spends no sponsor
  UTxO.

The restore of a witnessed fee UTxO depends on the service clock. A clock
ahead of the chain shortens the hold. The
[restore margin](../glossary.md#restore-margin) absorbs ordinary drift. A
clock further ahead lets a fee UTxO be leased while a witness on it can still
land. One of the two transactions then fails in phase one, and the sponsor
loses nothing.

The audit trail shows a key whose leases are never used or whose witnesses
never land. See [runbook.md](../operators/runbook.md#a-client-key-misbehaves).

## Overspending an allowance

Each client key has three [quotas](../glossary.md#quota). The hourly witness
quota is checked before the provider is called, so a key over quota costs
the provider nothing. Both witness quotas are checked again in the database
transaction that records the witness. Requests in flight at the same time
cannot pass them together. A collateral witness counts against the hourly
quota and sponsors zero lovelace.

## Flooding the service

- Every request counts against its address's `IP_RATE_LIMIT_PER_MINUTE`
  before the body is read. Guessing keys or flooding costs the caller its own
  address first.
- Every `/v1` request counts against the key's `KEY_RATE_LIMIT_PER_MINUTE`
  once the key authenticates.
- A JSON body is capped at 64 KiB before it is parsed.
  [POL-1](../policy.md#pol-1-well-formed) caps a transaction at 16 KiB before
  it is decoded.
- The inputs and the reference inputs of a transaction are resolved in one
  provider call.
- [POL-5](../policy.md#pol-5-account-transaction) bounds the device keys one
  creation lists, which bounds the stake scripts one request makes the
  service derive. The service keeps at most 4096 derived stake script hashes
  in memory.

## Reading secrets

- The mnemonic reaches the process only through its environment. The service
  reads it once, derives the wallet, empties it from its configuration and
  removes it, the project id and the admin key from its process environment.
  The derived keys stay inside the wallet, encrypted in memory under a
  password drawn fresh for each process.
- The service never writes, logs or returns a signing key.
- Logs redact the authorization header and any field named after a mnemonic
  or a key, at the top of a log entry or one level down.
- A configuration error names the variable, never its value.
- An error answer never echoes the transaction. A refusal names the rule and
  the identifiers it reasoned about. An unexpected error answers a bare
  `internal_error`.
- Client keys are 32 random bytes, stored only as SHA-256 hashes and compared
  in constant time. The admin key is compared in constant time as well.
- The database holds key hashes, UTxO references, transaction hashes and
  witness sets, which are public keys and signatures. It never holds a
  transaction body or a secret.

## Chain reorganisations

The service never submits a client's transaction. A reorganisation of a
client's transaction is the client's to handle.

The pool sync settles each pool UTxO the chain stops listing, and each one it
lists again, as the [pool lifecycle](../operators/pool.md#lifecycle-of-a-pool-utxo)
shows. A witnessed fee UTxO stays out of the pool until every witness on it
has lapsed, whether or not its transaction was rolled back. A consumed shared
collateral is never designated again, even when a rollback brings it back. A
replenish never spends the shared collateral, so a transaction signed against
it stays valid for as long as its bound allows. A pool size change is the
exception, as [pool.md](../operators/pool.md#changing-the-pool-sizes) says.

## What the sponsor can lose

- Per fee mode witness, always an account creation: at most
  `MAX_SPONSORED_LOVELACE`. At most `MAX_FEE_LOVELACE` of it is the fee. The
  rest is the stake registration deposit, which the ledger holds against the
  account's stake credential, and the control output's lovelace, which stays
  in the account.
- Per collateral mode witness: nothing.
- Per client key and day: at most its `sponsoredLovelacePerDay`, however many
  requests are in flight.
- Per phase two failure the policy fails to foresee: at most
  `COLLATERAL_UTXO_LOVELACE`, the one shared collateral.
- Everything in the pool and the reserve, if the mnemonic or the host is
  compromised. Keep the sponsor wallet small and top it up as it drains.
