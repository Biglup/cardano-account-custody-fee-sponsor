# Verify the script data hash

- Status: Accepted
- Date: 2026-10

## Context and Problem

The service lends the [shared collateral](../glossary.md#shared-collateral) on
the strength of evaluation: a transaction whose scripts evaluate within their
declared budgets cannot fail in phase two, so it cannot take the collateral
([ADR 0001](0001-shared-collateral-without-a-lease.md)).

The sponsor's signature covers the transaction body. The redeemers and the
datums live in the witness set, which no signature covers. Anyone can replace
them after signing without invalidating the sponsor's signature. What ties
them to the body is the script data hash. It sits in the body, and the ledger
refuses in phase one a transaction whose witness set does not hash to it.

An evaluation endpoint judges the witness set in front of it and ignores the
hash in the body. A client can therefore build a body that commits to script
data it never shows, attach honest redeemers for evaluation, obtain the
signature, and swap in the data the body commits to. The ledger accepts the
swapped transaction in phase one. Its scripts then run unevaluated, and
redeemers that under declare their budgets fail in phase two and take the
collateral.

How does the service make its evaluation binding on what the signed body
accepts?

## Considered Options

1. Rely on evaluation of the transaction as presented.
2. Recompute the script data hash from the witness set as presented and the
   provider's cost models, and refuse anything but an exact match with the
   hash in the body.

## Decision

Option 2, as [POL-10](../policy.md#pol-10-script-data-hash). The rule runs
immediately before evaluation. It refuses a body that commits to other script
data, a body that commits to none while the witness set carries redeemers or
datums, and a body that commits to one while the witness set carries neither.
The redeemers and datums the service evaluates are then the only ones the
signed body accepts.

Every script an account runs is Plutus V3. The language view of the hash
depends on the languages of the scripts, so a transaction with any other
Plutus script is refused under the rule rather than hashed under a guessed
view.

### Consequences

- Evaluation binds: the collateral is safe from a witness set swapped after
  signing.
- The service reads the protocol parameters from its provider for every
  transaction that carries script data, so the cost models are the chain's
  current ones. A provider failure there refuses the transaction under
  `script_data_hash`.
- A transaction carrying a Plutus V1 or V2 script, attached or as a reference
  script on an input or a reference input, is refused when it carries
  redeemers or datums.
- The service trusts its provider's cost models as the chain's.
