# Creation must derive from a listed device

- Status: Accepted
- Date: 2026-10

## Context and Problem

In fee mode the sponsor pays for an account creation: the fee, the stake
registration deposit and the control output's lovelace
([ADR 0002](0002-fee-mode-for-creation-only.md)). A creation registers a
script stake credential, mints the state NFT named after it and locks the NFT
at the account address staked to it.

The account proxy mints the state NFT for any script credential. A client can
therefore register an always true script of its own as the credential, write
whatever state it likes into the control output, and have the sponsor pay for
an account none of the contract's owner guarantees hold for.

The contract's own stake script is the account stake validator applied to a
device key and to the account proxy hash. The validator requires the
registration to list its owner among the devices.

What must the service check before it pays for a creation?

## Considered Options

1. Accept any creation that registers one script stake credential and names
   the minted token after it.
2. Also require the registered credential to be the contract's stake script
   for one of the devices the control output lists, derived by the service
   from the contract blueprint.

## Decision

Option 2, as part of
[POL-5](../policy.md#pol-5-account-transaction). The service ships the
blueprint of the contract build it serves, read from `BLUEPRINT_PATH`. For
each device key the control output's datum lists, it applies the stake
validator to that key and to `ACCOUNT_SCRIPT_HASH`, and hashes the result as
a Plutus V3 script. The registered credential must equal one of those hashes.

### Consequences

- The sponsor pays only for accounts the contract governs.
- The service refuses to start on a blueprint whose account proxy does not
  hash to `ACCOUNT_SCRIPT_HASH`. The stake validator of another build would
  admit creations the configured proxy does not govern.
- A datum listing no device keys is refused. One listing more than 8, the
  most a well formed state carries, is refused before anything is derived.
  One request cannot make the service derive without bound.
- Derivation parses and encodes the validator. The service keeps each derived
  hash per device key, up to 4096 of them, forgetting the oldest first.
- A contract build with a different stake validator needs its blueprint
  shipped with the service.
