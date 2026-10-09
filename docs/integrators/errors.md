# Errors

Every error the service answers carries a JSON body with an `error` code. A
policy refusal adds the `rule` that refused the transaction. Most errors add a
`detail` sentence. Three carry none: `payload_too_large`, `internal_error`, and
an `invalid_request` the body parser or the router raises, such as JSON that
does not parse or a path parameter that does not decode.
[api.md](api.md#errors) describes the body, and lists which route answers which
code.

Branch on `error`, and on `rule` for `invalid_transaction`. The `detail` is for
people and its wording is not part of the API.

## Codes

| Status | Code | Retry | Summary |
| --- | --- | --- | --- |
| 400, 415 | [`invalid_request`](#invalid_request) | No | The request does not match the route, or its body cannot be read. |
| 401 | [`unauthorized`](#unauthorized) | No | No valid key for the route. |
| 404 | [`not_found`](#not_found) | No | No such route, or no such key on the admin route. |
| 404 | [`unknown_lease`](#unknown_lease) | No | This key holds no lease with that id. |
| 409 | [`lease_consumed`](#lease_consumed) | No | The lease issued its witness for another transaction. |
| 409 | [`no_utxo_available`](#no_utxo_available) | Later | No fee UTxO, or no collateral UTxO, is free. |
| 410 | [`lease_expired`](#lease_expired) | With a new lease | The lease expired or was released. |
| 413 | [`payload_too_large`](#payload_too_large) | No | The body is over 64 KiB. |
| 422 | [`invalid_transaction`](#invalid_transaction) | After a fix | The transaction breaks a policy rule. |
| 429 | [`rate_limited`](#rate_limited) | After `Retry-After` | Too many requests in the minute. |
| 429 | [`quota_exceeded`](#quota_exceeded) | Later | The key used up a quota. |
| 500 | [`internal_error`](#internal_error) | Yes | The service failed unexpectedly. |
| 503 | [`out_of_funds`](#out_of_funds) | After the operator funds the sponsor | The sponsor cannot fund a pool UTxO. |
| any | [`unexpected_response`](#unexpected_response) | Depends | Client adapter only. The answer carried no service error body. |

[retries-and-idempotency.md](retries-and-idempotency.md) explains when
presenting a transaction again is safe.

## invalid_request

- Status: 400, or 415 for a body in a charset outside the UTF family or in a
  content encoding the service does not read.
- Cause: the body cannot be read, the JSON does not parse, a path parameter
  does not decode, or the body, the path parameters or the query do not match
  the route. Unknown fields are
  refused. When validation fails, the detail names the first field at fault
  and the problem, such as `transaction: ...`, or `body: ...` for an unknown
  field.
- Fix: correct the request. On the witness routes, send
  `Content-Type: application/json` and a body of exactly
  `{ "transaction": "<CBOR hex>" }`. Do not retry the same request unchanged.

## unauthorized

- Status: 401.
- Cause: the route requires a key and the `Authorization` header is missing,
  is not `Bearer <key>`, or names a key that is unknown or disabled. On an
  admin route, the key is not the admin key. The detail is
  `A valid API key is required`, or `The admin API key is required` on an
  admin route.
- Fix: send the key as a bearer token. A key that worked before and answers
  401 has been disabled. Ask the operator for a new one. Do not retry.

## not_found

- Status: 404.
- Cause: no route matches the method and path. The detail is
  `No route for <METHOD> <path>`. On `DELETE /admin/keys/:id` it means no key
  has that id, with detail `No key <id> exists`.
- Fix: check the method and the path against [api.md](api.md). Under
  `/v1/leases`, `/v1/collateral` and `/admin` the key is checked before the
  route is matched. An unmatched path there answers `401 unauthorized` without
  a valid key, and `404 not_found` with one.

## unknown_lease

- Status: 404.
- Cause: the key that sent the request holds no lease with that id. A lease
  taken with another key is unknown to this one. The detail is
  `No lease <id> exists`.
- Fix: use the `leaseId` this key received from `POST /v1/leases`. Take a new
  lease if the id is lost.

## lease_consumed

- Status: 409.
- Cause: the lease already issued its witness, and the request presents a
  different transaction, or asks to release the lease. The detail is
  `Lease <id> already issued a witness`.
- Fix: a lease issues one witness. Presenting the transaction it was issued
  for answers that witness set again. For any other transaction, take a new
  lease. A consumed lease needs no release.

## no_utxo_available

- Status: 409.
- Cause: on `POST /v1/leases`, every fee UTxO is leased. The detail then says
  how many are leased and when the soonest lease expires. The pool can also
  lack a UTxO while the reserve could fund one. On `POST /v1/leases` that is a
  fee UTxO or a collateral UTxO. On `POST /v1/leases/:id/witness`,
  `GET /v1/collateral` and `POST /v1/collateral/witness` it is a collateral
  UTxO. The detail then says which, and that a replenish can split the
  reserve. The service reconciles the pool with the chain once before
  answering.
- Fix: when every fee UTxO is leased, retry after the soonest expiry the
  detail names, or after a lease is released. When the pool is empty, the
  operator must replenish it. Retry with backoff.

## lease_expired

- Status: 410.
- Cause: the lease reached its expiry, its client released it, or its fee
  UTxO left the pool. The detail is `Lease <id> has expired`, or
  `Lease <id> was released` on the witness route.
- Fix: take a new lease and rebuild the transaction on it. A transaction built
  on the old lease spends the old fee UTxO and cannot be witnessed on another
  lease. See [a lease that expires](retries-and-idempotency.md#a-lease-that-expires).

## payload_too_large

- Status: 413.
- Cause: the request body is over 64 KiB.
- Fix: a transaction is at most 16 KiB, so a witness request is far below the
  limit. Check that the body holds only the transaction.

## invalid_transaction

- Status: 422.
- Cause: the transaction breaks a rule of the [policy](../policy.md). `rule`
  names the first rule it breaks, in the order the policy checks them.
  `detail` says how.
- Effect: nothing is signed. The [audit trail](../glossary.md#audit-trail)
  records the refusal. An open lease stays open.
- Fix: correct the transaction and present it again. On the lease route, use
  the same lease.

```json
{
  "error": "invalid_transaction",
  "rule": "sponsor_outflow_bounded",
  "detail": "..."
}
```

| `rule` | Policy | Common cause | Fix |
| --- | --- | --- | --- |
| `well_formed` | [POL-1](../policy.md#pol-1-well-formed) | The value is not CBOR hex of a Conway transaction, is over 16 KiB, or carries a proposal procedure or a treasury donation. | Send the full transaction CBOR as hex. Remove governance proposals and donations. |
| `uses_leased_fee_input` | [POL-2](../policy.md#pol-2-sponsor-inputs) | Fee mode. The leased fee UTxO is not an input, or another [sponsor UTxO](../glossary.md#sponsor-utxo) is. | Build on the lease the request names. Spend no other sponsor UTxO. |
| `no_sponsor_inputs` | [POL-2](../policy.md#pol-2-sponsor-inputs) | Collateral mode. An input is a sponsor UTxO, often the shared collateral spent as a regular input. | Spend only the account's UTxOs, or the client's own. Declare the shared collateral as collateral only. |
| `uses_shared_collateral` | [POL-3](../policy.md#pol-3-shared-collateral) | The transaction declares a shared collateral the pool has since replaced. POL-3 lists every check. | Read the current shared collateral with `GET /v1/collateral`, or take a new lease, and rebuild. See [a dropped shared collateral](retries-and-idempotency.md#a-dropped-shared-collateral). |
| `bounded_validity` | [POL-4](../policy.md#pol-4-bounded-validity) | No validity upper bound, a bound already past, or a bound later than the lease expiry plus `VALIDITY_MARGIN_SECONDS` in fee mode, or later than `validitySeconds` past the request in collateral mode. | Set the bound inside the window. The [client adapter](client-adapter.md) presets it. Rebuild if the transaction waited too long. |
| `account_transaction` | [POL-5](../policy.md#pol-5-account-transaction) | The transaction neither operates an existing custody account nor creates one, or a creation registers a stake credential that is not the contract's stake script for a listed device. | Build with the contract's builders. List the creating device in the initial state, at most 8 devices. |
| `known_logic` | [POL-6](../policy.md#pol-6-known-logic) | A control UTxO or control output names a logic the operator does not list. | Use a logic version the service lists. The operator names them in `KNOWN_LOGIC_HASHES`. |
| `sponsor_outflow_bounded` | [POL-7](../policy.md#pol-7-sponsor-outflow) | Fee mode. The transaction is an operation, not a creation. POL-7 lists every check. | Send operations to `POST /v1/collateral/witness`. Build creations with the contract's `createAccount` and the adapter in fee mode. |
| `sponsor_outflow_zero` | [POL-7](../policy.md#pol-7-sponsor-outflow) | Collateral mode. An output pays the sponsor payment key, or a withdrawal draws from the sponsor's reward account. | Send change to the account or to the client, never to the sponsor. |
| `no_sponsor_value_elsewhere` | [POL-8](../policy.md#pol-8-no-sponsor-value-elsewhere) | An output to a third party is not covered by value that is not the sponsor's. | Fund third party outputs from the account or the client's own inputs. |
| `no_foreign_scripts` | [POL-9](../policy.md#pol-9-no-foreign-scripts) | The transaction runs or attaches a script that is not the account's, carries a native script witness, or withdraws from a reward account twice. | Run only the account proxy, its stake script and its named logic. |
| `script_data_hash` | [POL-10](../policy.md#pol-10-script-data-hash) | The script data hash does not match the final redeemers and datums. POL-10 lists every check. | Compute the hash from the final redeemers and datums with the chain's cost models. A detail saying the hash cannot be computed is the provider's failure: present the same transaction again later. |
| `evaluates` | [POL-11](../policy.md#pol-11-evaluates) | An input is not yet on chain or already spent. POL-11 lists every check. | Wait until the transactions that create the inputs confirm. Rebuild if an input was spent. Declare the budgets evaluation reports. A detail saying the inputs could not be resolved is the provider's failure: present the same transaction again later. |
| `signers` | [POL-12](../policy.md#pol-12-signers) | A sponsor key is a required signer, a certificate or a voter, or a withdrawal draws from the sponsor's reward account. | Never name a sponsor key in the transaction. |

A refusal under `signers` can also follow signing, when the sponsor wallet
would produce any signature beyond the sponsor payment key's.

## rate_limited

- Status: 429.
- Cause: the client address made `IP_RATE_LIMIT_PER_MINUTE` requests in the
  current minute, or the client key made `KEY_RATE_LIMIT_PER_MINUTE`. The
  detail is `Too many requests`.
- Fix: wait the seconds the `Retry-After` header gives, then retry. Spread
  requests using the `RateLimit` header. See [rate limits](api.md#rate-limits).

## quota_exceeded

- Status: 429.
- Cause: the key reached one of its [quotas](api.md#quotas). The detail starts
  with the quota:
  - `open_leases: at most N open leases per key`, on `POST /v1/leases`;
  - `witnesses_per_hour: at most N witnesses per hour per key`, on both witness
    routes;
  - `sponsored_lovelace_per_day: at most N sponsored lovelace per day per key`,
    on the lease witness route.
- Effect: an open lease stays open. The response carries no `Retry-After`.
- Fix: for `open_leases`, release a lease you no longer need or let one
  expire. For the witness quotas, wait for older witnesses to leave the sliding
  window, an hour or 24 hours after they were issued. Ask the operator for a
  key with larger quotas if the limit is regular.

## internal_error

- Status: 500.
- Cause: an error the service did not anticipate, such as a provider failure
  outside the policy rules. On `POST /admin/pool/replenish` it also means the
  split did not confirm within 180 seconds.
- Fix: retry with backoff. Presenting the same transaction again is safe. See
  [the same transaction presented twice](retries-and-idempotency.md#the-same-transaction-presented-twice).

## out_of_funds

- Status: 503.
- Cause: the pool holds no fee UTxO, or no collateral UTxO, and the
  [reserve](../glossary.md#reserve) holds too little to split one. The detail
  says what the reserve holds and what a split needs. On
  `POST /admin/pool/replenish` it means the reserve cannot fund a single
  output.
- Fix: the operator must fund the sponsor address and replenish. Retry with a
  long backoff, or alert the operator.

## unexpected_response

This code is never sent by the service. The [client adapter](client-adapter.md)
reports it as a [`SponsorError`](client-adapter.md#sponsorerror) when a
response fails and its body is not JSON or carries no string `error` field.
This happens when something between the client and the service answers, such
as a reverse proxy, a gateway or a load balancer.

- `status` is the HTTP status received.
- `code` is `unexpected_response`.
- `rule` is undefined.
- `detail` is `The sponsor service answered with status <status>`.

Fix: check `baseUrl` and the network path to the service. Treat a 502, 503
or 504 as transient and retry with backoff. Treat a 404 as a wrong `baseUrl`.

A failure to reach the service at all is not a `SponsorError`. It is the
error the `fetch` function throws.
