# Client adapter

`SponsorWallet` is the [client adapter](../glossary.md#client-adapter). It
implements cometa's `Wallet` interface over the [API](api.md). The account
custody contract's transaction builders take a `Wallet` for whoever pays or
provides collateral. Passing them a `SponsorWallet` puts the service in that
role, and the builders work unchanged.

The adapter is used in one of two modes:

| Mode | Pass it to the contract builders as | Serves | Service routes |
| --- | --- | --- | --- |
| `fee` (default) | `sponsor` of `createAccount` | A sponsored account creation | `POST /v1/leases`, `POST /v1/leases/:id/witness`, `DELETE /v1/leases/:id` |
| `collateral` | `collateral` of every owner operation, stake operation and grant spend | Any account transaction the account pays for | `GET /v1/collateral`, `POST /v1/collateral/witness` |

[quickstart.md](quickstart.md) shows both in use.

## Package

The package root exports:

| Export | Kind | Meaning |
| --- | --- | --- |
| `SponsorWallet` | class | The adapter. |
| `SponsorError` | class | A refusal by the service, as the adapter throws it. |
| `SponsorWalletMode` | type | `'fee' \| 'collateral'`. |
| `SponsorWalletOptions` | type | The constructor options. |
| `LeaseBody`, `CollateralBody`, `WitnessBody`, `CollateralWitnessBody`, `SponsorUtxoBody`, `ErrorResponseBody` | types | The response bodies of [api.md](api.md). |

The package is not published to a registry. Build it from a checkout with
`npm run build` and install it from that directory. Its runtime dependencies
include cometa.

```ts
import { SponsorError, SponsorWallet } from 'cardano-account-custody-fee-sponsor';
```

## One copy of cometa

cometa keeps its WebAssembly state per loaded copy of the library. An object
made by one copy, such as a script or a reward address, holds a pointer that
another copy reads as garbage. The adapter, the contract library and your code
must therefore share one copy.

- Await `Cometa.ready()` on that copy before the adapter is first used. The
  adapter does not load the WebAssembly module itself.
- Any cometa object you pass into a builder the adapter returns must come from
  the same copy.
- An install from a checkout, by a directory path or a `file:` link, keeps
  the package's own copy of cometa next to it. Point every resolution of
  `@biglup/cometa` at one copy before anything loads cometa. `scripts/shared-cometa.ts` in this repository does this: imported
  first, it resolves every `require('@biglup/cometa')` in the process to the
  copy installed next to it.

## Constructor

```ts
new SponsorWallet(options: SponsorWalletOptions)
```

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `string` | yes | Where the service listens, such as `https://sponsor.example`. Trailing slashes are removed. The API paths are appended to it. |
| `apiKey` | `string` | yes | The [client key](../glossary.md#client-key). It is sent as a bearer token. |
| `provider` | `Provider` | yes | A cometa provider for the network the service serves. The adapter reads protocol parameters, evaluates and submits through it. |
| `mode` | `'fee' \| 'collateral'` | no | Default `'fee'`. |
| `fetch` | `typeof fetch` | no | The function the service is called with. Default `globalThis.fetch`. |
| `now` | `() => Date` | no | The clock the lease expiry and the collateral validity bound are measured against. Default the system clock. |

Constructing the adapter calls nothing. The first method that needs something
to build on fetches it: a lease in fee mode, the shared collateral in
collateral mode.

## Properties

| Property | Type | Meaning |
| --- | --- | --- |
| `lease` | `LeaseBody \| undefined` | Fee mode: the lease the adapter holds. `undefined` before the first use, after a witness consumed the lease, after `release()`, once `expiresAt` has passed on the adapter's clock, after `unknown_lease`, `lease_expired`, `lease_consumed` or a refusal under `uses_shared_collateral`, and always in collateral mode. |
| `collateral` | `CollateralBody \| undefined` | Collateral mode: the shared collateral the adapter holds. `undefined` before the first use, after `release()`, after a refusal under `uses_shared_collateral`, and always in fee mode. |

## Wallet methods

"Fetches" means the method takes a lease in fee mode, or reads
`GET /v1/collateral` in collateral mode, when the adapter holds none. Calls
that start while a fetch is in flight wait for that one. A wallet asked
several things at once on first use takes one lease, not one per call.

| Method | Fee mode | Collateral mode | Fetches |
| --- | --- | --- | --- |
| `getAddress()` | The sponsor address | The sponsor address | Yes |
| `getChangeAddress()` | The sponsor address | The sponsor address | Yes |
| `getUsedAddresses()` | `[sponsor address]` | `[sponsor address]` | Yes |
| `getUnusedAddresses()` | `[]` | `[]` | No |
| `getUnspentOutputs()` | `[leased fee UTxO]` | `[]` | Yes |
| `getBalance()` | The fee UTxO's lovelace | Zero | Yes |
| `getCollateral()` | `[shared collateral the lease named]` | `[shared collateral]` | Yes |
| `getRewardAddresses()` | `[]` | `[]` | No |
| `getRegisteredPubStakeKeys()`, `getUnregisteredPubStakeKeys()` | `[]` | `[]` | No |
| `getNetworkId()`, `getNetworkMagic()` | From the provider | From the provider | No |
| `createTransactionBuilder()` | See [fee mode](#fee-mode) | See [collateral mode](#collateral-mode) | Yes |
| `signTransaction(tx, partialSign)` | Posts to the lease witness route | Posts to the collateral witness route | Fee mode only, when it holds no lease |
| `submitTransaction(tx)` | Submits through the provider | Submits through the provider | No |
| `signData()` | Rejects: the sponsor signs transactions only | Same | No |
| `getPubDRepKey()` | Rejects: the sponsor has no DRep key | Same | No |

`signTransaction` returns the sponsor's witness set as cometa's
`VkeyWitnessSet`. It holds the sponsor payment key's signature alone, whatever
`partialSign` says. Merge it with the other signatures, apply them with
`applyVkeyWitnessSet`, and submit.

`createTransactionBuilder()` takes the network's slot timing from the
provider's network magic: mainnet, preprod or preview. Any other magic throws
`Unsupported network magic`. It reads the protocol parameters from the
provider for every builder.

## Fee mode

```ts
const sponsor = new SponsorWallet({ baseUrl, apiKey, provider });
```

Use it as the `sponsor` of the contract's `createAccount`. It is for that
builder alone. Fee mode pays for [creations](../glossary.md#creation) only.
Every other owner builder given a `sponsor` builds an operation, which the
service refuses under `sponsor_outflow_bounded`. Give those builders the
adapter in collateral mode as `collateral` instead.

### The lease the adapter holds

- The first use takes a lease.
- The lease is held until a witness consumes it, `release()` gives it up, or
  its `expiresAt` passes on the adapter's clock.
- The next use after that takes a new lease.
- An expired lease is dropped without a call to the service. The service
  expires it by itself.

### The builder

`createTransactionBuilder()` returns a cometa `TransactionBuilder` preset
with:

- the leased fee UTxO as the only UTxO it may spend;
- the shared collateral the lease named as the only collateral;
- the sponsor address as the change address and the collateral return
  address;
- the provider as the evaluator;
- the validity upper bound at the lease's `expiresAt`.

The contract's `createAccount` sets no bound of its own, so its transaction
passes [POL-4](../policy.md#pol-4-bounded-validity) as built. A caller that
sets its own bound must keep it within the lease expiry plus
`VALIDITY_MARGIN_SECONDS`.

### Signing

`signTransaction` posts the transaction to the witness route of the lease it
holds. It takes a lease first when it holds none.

- On success the lease is consumed. The adapter remembers which lease the
  transaction consumed.
- Signing that same transaction again goes back to the lease it consumed and
  receives the same witness set. A client that lost the answer gets the
  witness set back without taking a second lease.
- After a refusal, [Refusals](#refusals) says what the adapter keeps.

A transaction must be signed on the lease it was built on. If the lease is
dropped between building and signing, `signTransaction` takes a new lease, and
the service refuses the transaction there under `uses_leased_fee_input`.
Build again with `createAccount`, which builds on the new lease.

## Collateral mode

```ts
const collateral = new SponsorWallet({ baseUrl, apiKey, provider, mode: 'collateral' });
```

Use it as the `collateral` of any owner operation, stake operation or grant
spend of the contract library: `spendWithDevice`, `rewriteState`,
`upgradeLogic`, `addDevice`, `removeDevice`, `issueGrant`, `revokeGrant`,
`revokeAllGrants`, `sweepGrant`, `withdrawRewards`, `delegateStake` and
`spendWithGrant`. The account pays the fee and the outputs from its own
UTxOs. The service lends the shared collateral and nothing else. A device
wallet or an agent wallet that holds no ADA can then operate the account.

The contract's `createAccount` takes no `collateral` option. A client that
funds a creation itself and wants the sponsor's collateral assembles that
transaction on its own builder, within the [policy](../policy.md).

### The collateral the adapter holds

- The first use reads `GET /v1/collateral` and holds the answer.
- No lease is taken and nothing is reserved.
- The adapter holds the shared collateral until `release()`, or until a
  refusal under `uses_shared_collateral`. The next use then reads it again.

### The builder

`createTransactionBuilder()` returns a cometa `TransactionBuilder` preset
with:

- no UTxO to spend, and a coin selector that adds none, so the inputs the
  caller adds must cover the transaction;
- the shared collateral as the only collateral, its return paying the sponsor
  address;
- the provider as the evaluator;
- the validity upper bound at the time of the call plus `validitySeconds`,
  less the smaller of 60 seconds and half of `validitySeconds`.

The change address is the caller's to set. Change to the sponsor is refused
in this mode. The contract's builders set it to the account and add the
account's own UTxOs as inputs. An owner builder given a `validUntilSlot` sets
that bound in place of the preset one. A grant spend's bound is the
`validUntilSlot` its caller passes. Either must fall within the window.

### Signing

`signTransaction` posts the transaction to `POST /v1/collateral/witness`. The
service keys collateral witnesses by transaction, so signing the same
transaction again receives the same witness set. After a refusal,
[Refusals](#refusals) says what the adapter keeps.

## Refusals

After a refusal the adapter drops what can no longer be built on, then throws
the [`SponsorError`](#sponsorerror).

| Refusal | Fee mode | Collateral mode |
| --- | --- | --- |
| `unknown_lease`, `lease_expired`, `lease_consumed` | Drops the lease. The next use takes a new one. | Not answered in this mode. |
| `invalid_transaction` under `uses_shared_collateral` | Gives the lease back to the service and drops it. The next use takes a lease naming the current shared collateral. A failure to give the lease back is not reported. The lease then expires by itself. | Forgets the shared collateral. The next builder reads the current one. Build the transaction again. |
| Any other | Keeps the lease open. Rebuild and sign the corrected transaction on it. | Keeps the shared collateral. |

Signing again a transaction that already consumed a lease posts to that lease.
A refusal there leaves the lease the adapter holds untouched.

## release()

```ts
await wallet.release();
```

Leaves the adapter holding nothing.

- A lease or collateral request still in flight is awaited, and what it
  yields is given up too.
- Fee mode: an open lease is released with `DELETE /v1/leases/:id`. A failed
  release throws a `SponsorError`. With no lease held, nothing is called.
- Collateral mode: the shared collateral is forgotten. Nothing is called.

Release a lease you will not build on, so its fee UTxO returns to the pool at
once and the key's `openLeases` quota frees up.

## SponsorError

The adapter throws a `SponsorError` when a call to the service fails.

```ts
class SponsorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly rule: string | undefined;
  readonly detail: string;
}
```

| Field | Meaning |
| --- | --- |
| `status` | The HTTP status of the answer. |
| `code` | The service's `error` code, or `unexpected_response`. |
| `rule` | The policy rule, when `code` is `invalid_transaction`. Otherwise `undefined`. |
| `detail` | The service's `detail`. When the answer carries none, the code. |

`name` is `SponsorError`. `message` is `<code>: <detail>`, or
`<code> (<rule>): <detail>` when a rule is present.

When the answer fails and its body is not JSON, or carries no string `error`,
the adapter throws a `SponsorError` with code
[`unexpected_response`](errors.md#unexpected_response). That happens when a
proxy or gateway answers in place of the service.

Errors that are not a `SponsorError` pass through unchanged: a network
failure the `fetch` function throws, a provider failure, and the rejections of
`signData` and `getPubDRepKey`.

```ts
try {
  const witnesses = await sponsor.signTransaction(tx, true);
} catch (error) {
  if (error instanceof SponsorError && error.code === 'invalid_transaction') {
    console.error(`Refused under ${error.rule}: ${error.detail}`);
  }
  throw error;
}
```

[errors.md](errors.md) says how to handle each code, and
[retries-and-idempotency.md](retries-and-idempotency.md) when to retry.
