# Fee mode for creation only

- Status: Accepted
- Date: 2026-10

## Context and Problem

An account creation costs a fee, a stake registration deposit and the
lovelace of the control output. Before creation there is no account to pay
from, and the owner may hold no ADA. Someone else must pay.

After creation the account holds its own UTxOs. An owner operation can draw
its fee from an account reserve or from the account's funds. An agent spend
draws from the funds. What the owner or agent still lacks is collateral.

The contract's owner builders accept a `sponsor` that pays the fee. Used with
an operation, such a sponsor also pays the growth of the control output and
receives withdrawn rewards as change. An exact outflow check refuses both, so
a sponsored operation passes or fails depending on the state it writes.

Which transactions should a leased fee UTxO pay for?

## Considered Options

1. Fee mode pays the fee of any account transaction, plus the deposit and the
   control output's lovelace at creation.
2. Fee mode pays for creations only. Operations take collateral mode and pay
   their own fee.

## Decision

Option 2. [POL-7](../policy.md#pol-7-sponsor-outflow) refuses an operation in
fee mode under `sponsor_outflow_bounded`, whatever it draws. A creation must
draw exactly the fee, the deposit and the control output's lovelace.

### Consequences

- The sponsor's exposure in fee mode is limited to creations. Each costs at
  most `MAX_SPONSORED_LOVELACE`, of which at most `MAX_FEE_LOVELACE` is the
  fee. The control output's lovelace stays in the account. The ledger holds
  the registration deposit against the account's stake credential.
- The fee mode adapter is for the contract's `createAccount` alone. Every
  other owner builder given a `sponsor` is refused. Operations take the
  adapter in collateral mode as `collateral`.
- An account must hold ADA before it can operate. Its owner, or anyone, funds
  it with a deposit.
- In collateral mode the fee is the account's, and the service does not cap
  it.
