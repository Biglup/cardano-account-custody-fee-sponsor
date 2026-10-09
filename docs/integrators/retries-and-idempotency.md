# Retries and idempotency

A client loses answers, holds leases that run out and builds on collateral
that can change. This page says what the service does in each case and what
the client should do. [errors.md](errors.md) describes each error code, and
[flows.md](flows.md#lease-lifecycle) shows the life of a lease.

## Which requests are safe to repeat

| Request | Repeat it? | Why |
| --- | --- | --- |
| `GET /health`, `GET /v1/collateral` | Yes | They change nothing. |
| `POST /v1/leases` | With care | Each call takes a new lease and counts against `openLeases`. A lost answer leaves a lease the client cannot name. It holds its fee UTxO until it expires. |
| `DELETE /v1/leases/:id` | Yes | Releasing a released lease answers `200` again. |
| `POST /v1/leases/:id/witness` | Yes, with the same transaction | The same transaction on the same lease receives the same witness set. |
| `POST /v1/collateral/witness` | Yes, with the same transaction | The same transaction receives the same witness set, from any key. |

Submitting the signed transaction is the client's matter, as the
[overview](../overview.md#where-it-sits) describes. The ledger accepts a
transaction once.

## The same transaction presented twice

The service records each witness with the hash of the transaction it signs.
The hash covers the transaction body only. Adding signatures to the witness
set does not change it.

### In fee mode

A lease issues one witness and is then consumed. Presenting the same
transaction again on that lease answers `200` with the witness set already
issued. The repeat issues nothing new, so it counts once against the quotas,
and the [audit trail](../glossary.md#audit-trail) records it as `reissued`.

Two requests that arrive at the same moment can be the exception. The service
checks the key's quotas once more before it finds the lease consumed. By then
the first request's witness counts against them. At a quota boundary the later
request answers `429 quota_exceeded` instead of the witness set. Presenting
the transaction again afterwards answers the witness set.

A different transaction on a consumed lease answers `409 lease_consumed`.

So after a timeout, a dropped connection or a `500` on the witness route,
present the same transaction on the same lease. The answer is the witness set,
or the refusal the transaction would have received.

The [client adapter](client-adapter.md) does this for you. When
`signTransaction` receives the transaction its last witness was issued for, it
asks the lease that transaction consumed, not a new one.

### In collateral mode

No lease is involved. The witness is keyed by the transaction hash alone.
Presenting a transaction that already received a collateral mode witness
answers `200` with that witness set, whichever key asks. The repeat is not
checked against the quotas and does not count. Two requests at the same moment
can meet the same quota exception as in fee mode.

A transaction witnessed in fee mode is not answered again on the collateral
route. It is checked under collateral mode and refused there, since it spends
a sponsor UTxO.

### Changing the transaction

Any change to the body is a different transaction with a different hash. On
the lease route it needs an open lease. On the collateral route it is checked
from the start and counts as a new witness.

## A lease that expires

A lease is open for `LEASE_TTL_SECONDS` from the moment it is taken. The
`expiresAt` field of the lease says when it ends. Past that time:

- the witness route answers `410 lease_expired`;
- the release route answers `410 lease_expired`;
- the fee UTxO returns to the pool for another lease.

A lease can also end as expired before `expiresAt` when its fee UTxO leaves
the pool. This happens when the chain no longer lists the UTxO, or when the
operator changes the pool sizes.

What to do:

1. Take a new lease.
2. Rebuild the transaction on it. The new lease names a different fee UTxO,
   and possibly a different shared collateral.
3. Present the new transaction on the new lease.

A transaction built on the old lease cannot be witnessed on the new one. It
spends the old fee UTxO, and
[POL-2](../policy.md#pol-2-sponsor-inputs) refuses it under
`uses_leased_fee_input`.

Build and present the transaction soon after taking the lease. The client
adapter treats a lease as gone once `expiresAt` has passed on its own clock,
and takes a new lease on its next use.

### After the witness

The witness consumes the lease, so expiry no longer applies to it. What limits
the transaction is its [validity upper bound](../glossary.md#validity-upper-bound),
at most the lease expiry plus `VALIDITY_MARGIN_SECONDS`. Submit before that
bound. Once it passes, the transaction can never land. Take a new lease and
build again.

The [restore margin](../glossary.md#restore-margin) says when a witnessed fee
UTxO that never landed returns to the pool.

## A refused witness

A refusal changes nothing the client holds. An open lease stays open.

| Answer | What to do |
| --- | --- |
| `422 invalid_transaction` | Fix what `rule` names, as [errors.md](errors.md#invalid_transaction) describes, and present the corrected transaction. In fee mode, use the same lease while it is open. |
| `422` under `evaluates` or `script_data_hash`, with a detail saying the inputs could not be resolved or the hash cannot be computed | The service could not reach its provider. Present the same transaction again after a short wait. |
| `422` under `evaluates`, with a detail naming an input the chain does not know | Wait for the transaction that creates the input to confirm, then present the same transaction again. If the input was spent, rebuild. |
| `422` under `bounded_validity`, with a bound already past | Rebuild with a later bound. In fee mode, take a new lease if this one has expired. |
| `429 quota_exceeded` | Wait. The witness quotas slide over the last hour and the last 24 hours. |
| `429 rate_limited` | Wait the seconds `Retry-After` gives. |
| `409 no_utxo_available`, `503 out_of_funds` | The pool holds no collateral UTxO. Retry later. The operator must replenish. |
| `404 unknown_lease`, `410 lease_expired`, `409 lease_consumed` on a new transaction | The lease cannot be built on. Take a new lease and rebuild. |

Do not retry a `422` unchanged unless its detail points at the provider or at
an input still confirming. The same transaction meets the same rule again.

The client adapter acts on some of these by itself, as
[its refusals](client-adapter.md#refusals) list.

## A dropped shared collateral

Every witnessed transaction declares the
[shared collateral](../glossary.md#shared-collateral). The
[pool sync](../glossary.md#pool-sync) replaces it with a
[spare collateral](../glossary.md#spare-collateral) UTxO in two cases:

- the chain no longer lists it, as after a phase two failure that took it;
- it no longer matches the collateral size, after the operator changes the
  pool sizes.

A replaced shared collateral is never designated again.

What this means for a transaction in flight:

| State of the transaction | Result | What to do |
| --- | --- | --- |
| Built, not yet witnessed | The witness request is refused under `uses_shared_collateral`. | Read `GET /v1/collateral`, or take a new lease in fee mode, and rebuild on the current shared collateral. |
| Witnessed, not yet submitted, the old UTxO spent on chain | The ledger refuses it, since its collateral input no longer exists. | Rebuild on the current shared collateral and request a new witness. In fee mode, take a new lease. |
| Witnessed, not yet submitted, the old UTxO still on chain | It can still land while its validity bound allows. | Submit it before the bound. |

In fee mode the lease names the shared collateral at the time it was taken.
The witness route checks the collateral against the designation at the time
of the request. A lease taken before a replacement therefore names a
collateral the policy no longer accepts. With the raw API, the client can read
the current one from `GET /v1/collateral` and rebuild on the same lease. The
client adapter takes a new lease instead, as
[its refusals](client-adapter.md#refusals) list.

When no spare collateral is left, both modes answer `409 no_utxo_available`
or `503 out_of_funds` until the operator replenishes. `GET /health` reports
`"shared": false` meanwhile.
