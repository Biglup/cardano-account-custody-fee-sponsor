# API reference

The fee sponsor serves a JSON API over HTTP. This page lists every route, its
authentication, its request and response bodies and every status it answers.
The [overview](../overview.md) explains what the service is for, and
[errors.md](errors.md) explains each error code and how to recover from it.

## Conventions

### Base URL

Every path below is relative to the address the service listens on, such as
`https://sponsor.example`. The service has no path prefix of its own. It
serves the preprod network only.

The examples set these shell variables:

```sh
SPONSOR_URL=https://sponsor.example
CLIENT_KEY=<a client key>
ADMIN_KEY=<the admin key>
```

### Authentication

Every route except `GET /health` requires a bearer token:

```
Authorization: Bearer <key>
```

- The `/v1` routes take a [client key](../glossary.md#client-key). The admin
  key issues it.
- The `/admin` routes take the [admin key](../glossary.md#admin-key).

The scheme name is case insensitive. The header must hold the scheme and
exactly one token. A missing, malformed, unknown or disabled key answers
`401 unauthorized`. The answer is the same in each case, so it reveals nothing
about which keys exist.

A lease belongs to the client key that took it. Another key sees it as
`unknown_lease`.

### Request bodies

Request bodies are JSON, sent with `Content-Type: application/json`. The
service parses a JSON body before any route runs, on every route, including a
route that reads no body. A body sent under another content type is not read.
The route then sees an empty body and answers `400 invalid_request` if it
requires a field.

A body is at most 64 KiB. Every body schema is strict: a field the route does
not name answers `400 invalid_request`.
[Errors any route can answer](#errors-any-route-can-answer) lists the statuses
of the body parser.

### Response bodies

Successful responses are JSON. Times are ISO 8601 strings in UTC with
milliseconds, such as `2026-10-07T13:40:45.753Z`. Lovelace amounts on the
`/v1` routes are JSON numbers. The reserve lovelace on the `/admin` routes is
a decimal string.

### Errors

Every error answers a JSON body of this shape:

```json
{ "error": "invalid_transaction", "rule": "bounded_validity", "detail": "..." }
```

| Field | Type | Present |
| --- | --- | --- |
| `error` | string | Always. The error code. |
| `rule` | string | Only with `invalid_transaction`. The [policy](../policy.md) rule that refused the transaction. |
| `detail` | string | On most errors. A sentence for people. [errors.md](errors.md) says which errors carry none. |

Branch on `error` and `rule`. Do not parse `detail`.
[errors.md](errors.md) lists every code.

### Errors any route can answer

Every route can answer these. The status table of each route below lists only
the statuses particular to that route.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | The body parser cannot read the JSON, or a path parameter does not decode. |
| 401 | `unauthorized` | The route requires a key and the request carries no valid one. |
| 404 | `not_found` | No route matches the method and path. [not_found](errors.md#not_found) says when an unmatched path answers 401 instead. |
| 413 | `payload_too_large` | The body is over 64 KiB. |
| 415 | `invalid_request` | The body parser refuses the charset or the content encoding, as [invalid_request](errors.md#invalid_request) states. |
| 429 | `rate_limited` | The client address, or the client key, used up its requests for the minute. See [rate limits](#rate-limits). |
| 500 | `internal_error` | An error the service did not anticipate. |

## Client routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | [`/health`](#get-health) | Network and pool counts |
| `POST` | [`/v1/leases`](#post-v1leases) | Take a lease |
| `DELETE` | [`/v1/leases/:id`](#delete-v1leasesid) | Release a lease |
| `POST` | [`/v1/leases/:id/witness`](#post-v1leasesidwitness) | Fee mode: obtain the sponsor witness for an account creation |
| `GET` | [`/v1/collateral`](#get-v1collateral) | Read the shared collateral |
| `POST` | [`/v1/collateral/witness`](#post-v1collateralwitness) | Collateral mode: obtain the sponsor witness for an account transaction |

### GET /health

Reports that the service is up, the network it serves and the
[pool](../glossary.md#pool) counts.

- Auth: none.
- Request body: none.

Response `200`:

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

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | Always `true`. |
| `network` | string | Always `preprod`. |
| `pool.fee.free` | number | Fee UTxOs a lease can take. |
| `pool.fee.leased` | number | Fee UTxOs held by an open lease. |
| `pool.collateral.shared` | boolean | Whether a [shared collateral](../glossary.md#shared-collateral) is designated and free. |
| `pool.collateral.spare` | number | Free collateral UTxOs other than the shared collateral. |
| `pool.collateral.consumed` | number | Shared collateral UTxOs the chain has taken. |

The counts come from the service's database. A `200` does not mean the
provider is reachable at that moment.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The service is up. |

```sh
curl "$SPONSOR_URL/health"
```

### POST /v1/leases

Takes a [lease](../glossary.md#lease): the oldest free
[fee UTxO](../glossary.md#fee-utxo), reserved for this key for
`LEASE_TTL_SECONDS`.

- Auth: client key.
- Request body: none. The route reads no field of a body.

Response `201`:

```json
{
  "leaseId": "b26ee940-dd6d-4456-b6c4-8336af3364ff",
  "expiresAt": "2026-10-07T13:40:45.753Z",
  "fee": { "txHash": "4c08...31f2", "index": 1, "address": "addr_test1...", "lovelace": 100000000 },
  "collateral": { "txHash": "1874...f2d0", "index": 1, "address": "addr_test1...", "lovelace": 5000000 },
  "sponsorAddress": "addr_test1...",
  "maxSponsoredLovelace": 6000000
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `leaseId` | string | The lease id, a UUID. |
| `expiresAt` | string | When the lease expires. |
| `fee` | object | The leased fee UTxO. |
| `collateral` | object | The shared collateral at the time of the answer. The lease does not reserve it. |
| `sponsorAddress` | string | The [sponsor address](../glossary.md#sponsor-address). The change and the collateral return pay it. |
| `maxSponsoredLovelace` | number | `MAX_SPONSORED_LOVELACE`, the most the creation may draw from the fee UTxO. |

`fee` and `collateral` each hold:

| Field | Type | Meaning |
| --- | --- | --- |
| `txHash` | string | The id of the transaction that created the UTxO, as hex. |
| `index` | number | The output index. |
| `address` | string | The address the UTxO sits at: the sponsor address. |
| `lovelace` | number | The lovelace it holds. It holds nothing else. |

Build the creation on these values.
[A dropped shared collateral](retries-and-idempotency.md#a-dropped-shared-collateral)
says what happens when the shared collateral changes before the witness
request.

| Status | Code | When |
| --- | --- | --- |
| `201` | | The lease is taken. |
| `409` | `no_utxo_available` | Every fee UTxO is leased, or the pool holds no fee UTxO or no collateral UTxO and the reserve could fund one by a replenish. The detail says which. When every fee UTxO is leased it says how many and when the soonest lease expires. |
| `429` | `quota_exceeded` | The key holds its `openLeases` quota. Detail `open_leases: at most N open leases per key`, where N is that quota. |
| `503` | `out_of_funds` | The pool holds no fee UTxO or no collateral UTxO, and the reserve cannot fund one. |

Before answering `409` or `503` the service reconciles the pool with the chain
once.

```sh
curl -X POST "$SPONSOR_URL/v1/leases" \
  -H "Authorization: Bearer $CLIENT_KEY"
```

### DELETE /v1/leases/:id

Releases an open lease. Its fee UTxO is free for another lease at once.

- Auth: client key.
- Path: `id`, the `leaseId` of a lease this key took.
- Request body: none.

Response `200`:

```json
{ "leaseId": "b26ee940-dd6d-4456-b6c4-8336af3364ff", "status": "released" }
```

Releasing a lease that is already released answers the same `200`.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The lease is released, or was already. |
| `404` | `unknown_lease` | This key holds no lease with that id. |
| `409` | `lease_consumed` | The lease has issued its witness. |
| `410` | `lease_expired` | The lease has expired. |

```sh
curl -X DELETE "$SPONSOR_URL/v1/leases/$LEASE_ID" \
  -H "Authorization: Bearer $CLIENT_KEY"
```

### POST /v1/leases/:id/witness

[Fee mode](../glossary.md#fee-mode). Checks an account
[creation](../glossary.md#creation) built on the lease against the
[policy](../policy.md) and, when it passes, returns the sponsor's
[witness](../glossary.md#witness). The witness consumes the lease.

- Auth: client key.
- Path: `id`, the `leaseId` of a lease this key took.

Request body:

```json
{ "transaction": "84a700d9010281825820..." }
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `transaction` | string | yes | The transaction as CBOR hex, at least one character. It may already carry other witnesses. |

Response `200`:

```json
{ "witnessSet": "a10081825820...", "leaseId": "b26ee940-dd6d-4456-b6c4-8336af3364ff" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `witnessSet` | string | A transaction witness set as CBOR hex. It holds one verification key witness, the sponsor payment key's signature, and nothing else. |
| `leaseId` | string | The lease the witness consumed. |

Merge `witnessSet` with the other signatures the transaction needs, then
submit it through your own provider, as the
[overview](../overview.md#where-it-sits) describes.

The service answers the first of these that applies:

1. `400 invalid_request` when the body does not match.
2. `404 unknown_lease` when this key holds no lease with that id.
3. `410 lease_expired` when the lease expired or was released.
4. `422 invalid_transaction` under `well_formed` when the transaction fails
   [POL-1](../policy.md#pol-1-well-formed).
5. On a consumed lease, `200` with the witness set already issued when the
   transaction is the same, and `409 lease_consumed` otherwise.
6. `429 quota_exceeded` when the key has used its `witnessesPerHour` quota.
7. `409 no_utxo_available` or `503 out_of_funds` when the pool holds no
   collateral UTxO to share.
8. `422 invalid_transaction` under the first [policy](../policy.md) rule the
   transaction breaks.
9. `429 quota_exceeded` when the [sponsored lovelace](../glossary.md#sponsored-lovelace)
   would exceed the key's `sponsoredLovelacePerDay` quota.
10. `200` with the witness set.

A refusal does not change the lease. After a refusal at step 4 or at steps 6
to 9 the lease stays open, and a corrected transaction can be presented on
it.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The witness is issued, or issued again for the same transaction. |
| `400` | `invalid_request` | The body is not `{ "transaction": "<non empty string>" }`. |
| `404` | `unknown_lease` | This key holds no lease with that id. |
| `409` | `lease_consumed` | The lease issued its witness for a different transaction. |
| `409` | `no_utxo_available` | No collateral UTxO is free and the reserve could fund one. |
| `410` | `lease_expired` | The lease expired or was released. The detail is `Lease <id> has expired` or `Lease <id> was released`. |
| `422` | `invalid_transaction` | The transaction breaks a policy rule, named in `rule`. |
| `429` | `quota_exceeded` | Detail `witnesses_per_hour: ...` or `sponsored_lovelace_per_day: ...`. |
| `503` | `out_of_funds` | No collateral UTxO is free and the reserve cannot fund one. |

Fee mode serves creations only. An operation on an existing account is
refused under `sponsor_outflow_bounded`. Send it to
[`POST /v1/collateral/witness`](#post-v1collateralwitness) instead.

```sh
curl -X POST "$SPONSOR_URL/v1/leases/$LEASE_ID/witness" \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"transaction\":\"$TX_CBOR\"}"
```

### GET /v1/collateral

Returns the [shared collateral](../glossary.md#shared-collateral) and the terms
of [collateral mode](../glossary.md#collateral-mode).

- Auth: client key.
- Request body: none.

Response `200`:

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

| Field | Type | Meaning |
| --- | --- | --- |
| `txHash` | string | The id of the transaction that created the shared collateral. |
| `index` | number | Its output index. |
| `address` | string | The address it sits at: the sponsor address. |
| `lovelace` | number | The lovelace it holds. Total collateral may not exceed it. |
| `sponsorAddress` | string | The address the collateral return must pay. |
| `validitySeconds` | number | `COLLATERAL_VALIDITY_SECONDS`. The validity upper bound may reach at most this far past the time of the witness request. |

Nothing is reserved. Every client reads the same UTxO.

| Status | Code | When |
| --- | --- | --- |
| `200` | | A shared collateral is designated. |
| `409` | `no_utxo_available` | No collateral UTxO is free and the reserve could fund one. |
| `503` | `out_of_funds` | No collateral UTxO is free and the reserve cannot fund one. |

Before answering `409` or `503` the service reconciles the pool with the chain
once.

```sh
curl "$SPONSOR_URL/v1/collateral" \
  -H "Authorization: Bearer $CLIENT_KEY"
```

### POST /v1/collateral/witness

[Collateral mode](../glossary.md#collateral-mode). Checks an account
transaction that takes no sponsor value against the [policy](../policy.md)
and, when it passes, returns the sponsor's witness. It serves operations on
existing accounts and creations the client funds itself. No lease is
involved.

- Auth: client key.

Request body:

```json
{ "transaction": "84a800d9010282825820..." }
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `transaction` | string | yes | The transaction as CBOR hex, at least one character. It may already carry other witnesses. |

Response `200`:

```json
{ "witnessSet": "a10081825820...", "txHash": "d886...4d03" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `witnessSet` | string | A transaction witness set as CBOR hex holding the sponsor payment key's signature and nothing else. |
| `txHash` | string | The hash of the transaction body the witness signs. |

The witness is keyed by the transaction hash. The same transaction presented
again, by any key, receives the same witness set.

The service answers the first of these that applies:

1. `400 invalid_request` when the body does not match.
2. `422 invalid_transaction` under `well_formed` when the transaction fails
   [POL-1](../policy.md#pol-1-well-formed).
3. `200` with the witness set already issued in collateral mode for this
   transaction, if there is one.
4. `429 quota_exceeded` when the key has used its `witnessesPerHour` quota.
5. `409 no_utxo_available` or `503 out_of_funds` when the pool holds no
   collateral UTxO to share.
6. `422 invalid_transaction` under the first policy rule the transaction
   breaks.
7. `200` with the witness set.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The witness is issued, or issued again for the same transaction. |
| `400` | `invalid_request` | The body is not `{ "transaction": "<non empty string>" }`. |
| `409` | `no_utxo_available` | No collateral UTxO is free and the reserve could fund one. |
| `422` | `invalid_transaction` | The transaction breaks a policy rule, named in `rule`. |
| `429` | `quota_exceeded` | Detail `witnesses_per_hour: ...`. |
| `503` | `out_of_funds` | No collateral UTxO is free and the reserve cannot fund one. |

A collateral mode witness sponsors zero lovelace. It counts against
`witnessesPerHour` only.

```sh
curl -X POST "$SPONSOR_URL/v1/collateral/witness" \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"transaction\":\"$TX_CBOR\"}"
```

## Admin routes

The operator calls these with the admin key. They obtain no witness for a
client transaction.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | [`/admin/keys`](#post-adminkeys) | Issue a client key |
| `GET` | [`/admin/keys`](#get-adminkeys) | List client keys |
| `DELETE` | [`/admin/keys/:id`](#delete-adminkeysid) | Disable a client key |
| `GET` | [`/admin/pool`](#get-adminpool) | Pool detail |
| `GET` | [`/admin/audit`](#get-adminaudit) | Read the audit trail |
| `POST` | [`/admin/pool/replenish`](#post-adminpoolreplenish) | Split the reserve into pool UTxOs |

Every admin route answers `401 unauthorized` with detail
`The admin API key is required` when the request does not carry the admin key.

### POST /admin/keys

Issues a client key.

- Auth: admin key.

Request body:

```json
{ "label": "my dapp", "quotas": { "witnessesPerHour": 30 } }
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `label` | string | yes | A name to recognise the key by. Trimmed, then 1 to 100 characters. |
| `quotas` | object | no | Overrides of the default [quotas](#quotas). |
| `quotas.openLeases` | integer | no | Leases the key may hold open at once. Positive. Default 5. |
| `quotas.witnessesPerHour` | integer | no | Witnesses the key may obtain in any hour. Positive. Default 60. |
| `quotas.sponsoredLovelacePerDay` | integer | no | Lovelace its fee mode witnesses may sponsor in any 24 hours. Positive. Default 600000000. |

Response `201`:

```json
{
  "apiKey": "q0bJ...",
  "id": 1,
  "label": "my dapp",
  "quotas": { "openLeases": 5, "witnessesPerHour": 30, "sponsoredLovelacePerDay": 600000000 }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `apiKey` | string | The client key: 32 random bytes as base64url. It is shown once. The service stores only its SHA-256 hash. |
| `id` | number | The key id, for listing and disabling. |
| `label` | string | The label as stored. |
| `quotas` | object | The effective quotas, defaults filled in. |

A key's quotas are fixed at issuance. To change them, issue a new key and
disable the old one.

| Status | Code | When |
| --- | --- | --- |
| `201` | | The key is issued. |
| `400` | `invalid_request` | The label is missing or out of range, a quota is not a positive integer, or a field is unknown. |

```sh
curl -X POST "$SPONSOR_URL/admin/keys" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"my dapp"}'
```

### GET /admin/keys

Lists every key ever issued, oldest first. The hash is never returned.

- Auth: admin key.
- Request body: none.

Response `200`:

```json
{
  "keys": [
    {
      "id": 1,
      "label": "my dapp",
      "quotas": { "openLeases": 5, "witnessesPerHour": 60, "sponsoredLovelacePerDay": 600000000 },
      "createdAt": "2026-10-07T12:00:00.000Z",
      "disabledAt": null
    }
  ]
}
```

`disabledAt` is the time the key was disabled, or `null` while it is active.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The keys. |

```sh
curl "$SPONSOR_URL/admin/keys" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### DELETE /admin/keys/:id

Disables a client key. Every later request with it answers
`401 unauthorized`. Its open leases are not released. They expire on their
own. Disabling is recorded on the [audit trail](../glossary.md#audit-trail).

- Auth: admin key.
- Path: `id`, a positive integer.
- Request body: none.

Response `200`:

```json
{ "id": 1, "label": "my dapp" }
```

Disabling a key that is already disabled answers the same `200`. The key
keeps the time it was first disabled.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The key is disabled, or was already. |
| `400` | `invalid_request` | The id is not a positive integer. |
| `404` | `not_found` | No key has that id. Detail `No key <id> exists`. |

```sh
curl -X DELETE "$SPONSOR_URL/admin/keys/1" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### GET /admin/pool

Closes every open lease past its expiry, then reports the pool.

- Auth: admin key.
- Request body: none.

Response `200`:

```json
{
  "pool": { "fee": { "free": 5, "leased": 0 }, "collateral": { "shared": true, "spare": 1, "consumed": 0 } },
  "reserve": { "utxos": 2, "lovelace": "812345678", "syncedAt": "2026-10-07T13:36:25.530Z" },
  "leases": { "open": 0 },
  "sharedCollateral": { "txHash": "1874...f2d0", "index": 1, "lovelace": 5000000, "chosenAt": "2026-10-07T12:00:00.000Z" },
  "utxos": [
    { "txHash": "4c08...31f2", "index": 1, "lovelace": 100000000, "kind": "fee", "status": "free", "discoveredAt": "2026-10-07T12:00:00.000Z" }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `pool` | object | The counts [`GET /health`](#get-health) reports. |
| `reserve.utxos` | number | UTxOs in the [reserve](../glossary.md#reserve) at the last [pool sync](../glossary.md#pool-sync). |
| `reserve.lovelace` | string | Lovelace in the reserve at the last pool sync. |
| `reserve.syncedAt` | string or null | When the reserve was last read, or `null` before the first sync. |
| `leases.open` | number | Open leases across every key. |
| `sharedCollateral` | object or null | The shared collateral with the time it was designated, or `null` when none is designated or the designated UTxO is no longer free. |
| `utxos` | array | Every free or leased pool UTxO, ordered by kind, then by when the pool first saw it. |
| `utxos[].kind` | string | `fee` or `collateral`. |
| `utxos[].status` | string | `free` or `leased`. |
| `utxos[].discoveredAt` | string | When the pool first saw the UTxO. |

| Status | Code | When |
| --- | --- | --- |
| `200` | | The pool. |

```sh
curl "$SPONSOR_URL/admin/pool" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### GET /admin/audit

Reads the [audit trail](../glossary.md#audit-trail), oldest first.

- Auth: admin key.
- Request body: none.

Query parameters:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `since` | ISO 8601 date and time | no | Entries at or after this time. It may carry an offset or omit the fraction of a second. Without it, from the beginning. |
| `limit` | integer | no | At most this many entries, 1 to 1000. Default 100. |

Response `200`:

```json
{
  "entries": [
    {
      "id": 42,
      "ts": "2026-10-07T13:31:02.114Z",
      "apiKeyId": 1,
      "action": "witness",
      "outcome": "issued",
      "detail": { "leaseId": "b26ee940-...", "txHash": "d886...4d03", "kind": "creation", "sponsoredLovelace": 4500000, "fee": "500000" }
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | number | The entry number, increasing. |
| `ts` | string | When the decision was made. |
| `apiKeyId` | number | The key that asked. Absent for a decision no key asked for. |
| `action` | string | `lease`, `witness`, `pool` or `key`. |
| `outcome` | string | What was decided, listed below. |
| `detail` | object | Identifiers, amounts and reasons. Never a transaction body or a key. |

| Action | Outcomes |
| --- | --- |
| `lease` | `created`, `released`, `expired`, `consumed`, `quota_exceeded`, `no_utxo_available`, `out_of_funds` |
| `witness` | `issued`, `reissued`, the name of the policy rule that refused the transaction, `unknown_lease`, `lease_expired`, `lease_released`, `lease_consumed`, `quota_exceeded`, `no_utxo_available`, `out_of_funds` |
| `pool` | `restored`, `retired`, `collateral_consumed` |
| `key` | `disabled` |

A `witness` entry names the lease, or carries `"mode": "collateral"`, and the
transaction hash. An `issued` entry also carries `kind` (`creation` or
`operation`), the sponsored lovelace and the fee.

To page through the trail, pass the `ts` of the last entry received as the next
`since`, and skip entries with an `id` already seen.

| Status | Code | When |
| --- | --- | --- |
| `200` | | The entries. |
| `400` | `invalid_request` | `since` is not an ISO 8601 date and time, `limit` is outside 1 to 1000, or the query names another parameter. |

```sh
curl "$SPONSOR_URL/admin/audit?since=2026-10-07T00:00:00Z&limit=500" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### POST /admin/pool/replenish

[Replenishes](../glossary.md#replenish) the pool. The service reconciles the
pool with the chain, splits the reserve with a transaction from the sponsor
wallet to itself, submits it, waits up to 180 seconds for it to confirm and
reconciles again.

- Auth: admin key.

Request body, every field optional:

```json
{ "feeUtxoCount": 5, "collateralCount": 1 }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `feeUtxoLovelace` | integer, positive | The size of each fee output. Default `FEE_UTXO_LOVELACE`. |
| `feeUtxoCount` | integer, 0 or more | Fee outputs to create. Default: enough to bring free and leased fee UTxOs up to `FEE_UTXO_COUNT`. |
| `collateralLovelace` | integer, positive | The size of each collateral output. Default `COLLATERAL_UTXO_LOVELACE`. |
| `collateralCount` | integer, 0 or more | Collateral outputs to create. Default: enough to bring free and leased collateral UTxOs up to `COLLATERAL_UTXO_COUNT`. |

The reserve funds the outputs after keeping back 3 ADA for the fee and the
change. Fee outputs come first, collateral outputs from what is left. The
pool takes up a UTxO within a tenth of `FEE_UTXO_LOVELACE` or of
`COLLATERAL_UTXO_LOVELACE`. An output of another size joins the reserve at the
next pool sync.

Response `200`:

```json
{ "txId": "9a41...0be7", "feeOutputs": 5, "collateralOutputs": 1, "reserveLovelace": "312345678" }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `txId` | string or null | The split transaction, or `null` when the pool is already at its targets. |
| `feeOutputs` | number | Fee outputs created. |
| `collateralOutputs` | number | Collateral outputs created. |
| `reserveLovelace` | string | Lovelace left in the reserve after the split. |

| Status | Code | When |
| --- | --- | --- |
| `200` | | The split confirmed, or nothing was needed. |
| `400` | `invalid_request` | A field is unknown, of the wrong type or out of range. |
| `500` | `internal_error` | The split did not confirm within 180 seconds, or the provider failed. |
| `503` | `out_of_funds` | The reserve cannot fund a single output. |

The request can take minutes. Give the HTTP client a timeout above 180
seconds.

```sh
curl -X POST "$SPONSOR_URL/admin/pool/replenish" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Quotas

Each client key carries three [quotas](../glossary.md#quota), set when the key
is issued.

| Quota | Default | Counts | Checked |
| --- | --- | --- | --- |
| `openLeases` | 5 | Leases the key holds open | On `POST /v1/leases` |
| `witnessesPerHour` | 60 | Witnesses issued to the key in the last hour, in both modes | On both witness routes, before the provider is called and again when the witness is recorded |
| `sponsoredLovelacePerDay` | 600000000 | Sponsored lovelace of the witnesses issued to the key in the last 24 hours | On the lease witness route, once the policy has established what the transaction sponsors, and again when the witness is recorded |

The windows slide: a witness stops counting one hour, or 24 hours, after it
was issued. A witness set answered again for the same transaction is not
issued again and does not count. The final check runs in the same database
transaction that records the witness, so concurrent requests cannot pass a
quota together.

A refusal answers `429 quota_exceeded`. Its detail starts with the quota name:
`open_leases`, `witnesses_per_hour` or `sponsored_lovelace_per_day`.

## Rate limits

Two limits apply per minute, over a fixed 60 second window.

| Limit | Default | Counts | Applies to |
| --- | --- | --- | --- |
| `IP_RATE_LIMIT_PER_MINUTE` | 120 | Requests from one client address | Every route, before anything reads the request |
| `KEY_RATE_LIMIT_PER_MINUTE` | 60 | Requests with one client key, after the key is authenticated | The `/v1` routes |

A request past either limit answers `429 rate_limited` with detail
`Too many requests` and a `Retry-After` header in seconds. Every response
carries the `RateLimit` and `RateLimit-Policy` headers of the IETF rate limit
headers draft 8, which give the remaining requests and the seconds until the
window resets.

Behind a reverse proxy, the client address is read from the forwarded headers
for `TRUST_PROXY_HOPS` hops.
