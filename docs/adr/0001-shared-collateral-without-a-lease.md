# Shared collateral without a lease

- Status: Accepted
- Date: 2026-10

## Context and Problem

Every account transaction runs the account's scripts, so it must declare
collateral. Only a wallet that holds ADA can provide collateral, and the owner
or agent of a custody account may hold none. The sponsor provides it.

The ledger takes collateral only when a script fails in phase two. The policy
refuses any transaction whose scripts do not evaluate within their declared
budgets ([POL-11](../policy.md#pol-11-evaluates)), and binds the evaluated
redeemers to the signed body ([POL-10](../policy.md#pol-10-script-data-hash)).
A witnessed transaction can then fail only in phase one, which takes no
collateral.

Most account transactions are operations that the account pays for itself.
They need the sponsor's collateral and nothing else.

How should the sponsor hand out collateral?

## Considered Options

1. Lease a collateral UTxO with each fee lease, one collateral UTxO backing a
   configured number of leases at once.
2. Designate one collateral UTxO, the shared collateral, that every witnessed
   transaction declares, without a lease.

## Decision

Option 2. The service designates one shared collateral UTxO. Both modes
require every witnessed transaction to declare it
([POL-3](../policy.md#pol-3-shared-collateral)). Nothing reserves it.

Nothing the service signs can take the collateral, so exclusive use protects
nothing. A lease would make an operation the account pays for hold a sponsor
resource it never spends. Without a lease, collateral mode needs no lease at
all: a client reads `GET /v1/collateral` and presents its transaction.

### Consequences

- Collateral mode is possible. It serves any account transaction that takes no
  sponsor value, with no lease, keyed by transaction hash.
- One collateral UTxO backs any number of transactions in flight. A client
  that obtains a collateral mode witness and never submits ties up no UTxO.
- The shared collateral must never be spent by anything else. The policy
  refuses it as a regular input ([POL-2](../policy.md#pol-2-sponsor-inputs)),
  it is never leased, and a replenish never spends it.
- Should the reasoning fail, the loss is the shared collateral alone, at most
  the lovelace it holds, and it happens once. The pool sync marks it
  consumed, records it on the audit trail and designates a spare collateral
  UTxO. `GET /health` reports the consumed count.
- A transaction built on a replaced shared collateral is refused and must be
  rebuilt on the current one.
- The service trusts its provider's evaluation. A provider that reports a
  passing evaluation the chain then fails can cost the shared collateral.
