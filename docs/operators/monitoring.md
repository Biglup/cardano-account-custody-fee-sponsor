# Monitoring

The service exposes three sources of signal: the health route, its logs and
the audit trail. This document says what each carries and what to watch.
[runbook.md](runbook.md) says what to do when a signal fires.

## The health route

`GET /health` takes no key. It answers 200 with the network and the pool
counts:

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

| Field | Meaning |
| ----- | ------- |
| `pool.fee.free` | Fee UTxOs free to lease |
| `pool.fee.leased` | Fee UTxOs held by open leases |
| `pool.collateral.shared` | Whether a [shared collateral](../glossary.md#shared-collateral) is designated and free |
| `pool.collateral.spare` | Free collateral UTxOs behind the shared one |
| `pool.collateral.consumed` | Collateral UTxOs the chain took, over the life of the database |

The counts come from the database, as of the last pool sync. A 200 means the
process is up and reached the provider at startup. It does not mean the
provider still answers.

`GET /admin/pool` adds the reserve, the time of the last successful pool
sync and every free or leased UTxO. [pool.md](pool.md#inspecting-the-pool)
describes it.

## Logs

The service writes JSON lines on stdout. Each line has a numeric `level`
(30 info, 40 warning, 50 error), a `time` and a `msg`. Every request produces
one line with its method, URL and status code, `request completed`, or
`request errored` for a 5xx answer. The authorization header and any field
named after a mnemonic or a key are redacted.

| `msg` | Level | Meaning |
| ----- | ----- | ------- |
| `Fee sponsor service listening` | info | Startup done. `address` is the sponsor address, `port` the port. |
| `Pool synced` | info | A pool sync ran. It counts what it `discovered`, `consumed`, marked `gone`, `restored` and `retired`, and the `reserveLovelace`. |
| `Pool sync failed` | error | A periodic pool sync failed, usually because the provider did not answer. |
| `Shared collateral designated` | info | A collateral UTxO became the shared collateral. |
| `Shared collateral consumed` | warning | The chain took the shared collateral. `next` is its replacement, or null. |
| `Pool UTxO retired, since it lies outside every pool size` | warning | A pool size changed under a tracked UTxO. |
| `Lease attempt lost a race and is retried` | warning | Two lease requests chose the same fee UTxO at once. |
| `Expired leases swept` | info | The sweep closed `expired` leases. |
| `Lease sweep failed` | error | The expiry sweep failed. |
| `Witness issued` | info | A witness left the service. |
| `Split submitted` | info | A replenish submitted its transaction, `txId`. |
| `Unhandled error` | error | A request failed in a way the service did not anticipate. It answered 500 `internal_error`. |

A service that fails to start prints one line on stderr,
`Fee sponsor service failed to start: <reason>`, and exits with code 1.

## The audit trail

The [audit trail](../glossary.md#audit-trail) records every decision on a
lease or a witness, key disablements and pool events. Read it with the admin
key:

```sh
curl --silent --header "Authorization: Bearer $ADMIN_API_KEY" \
  'http://127.0.0.1:8787/admin/audit?since=2026-10-07T00:00:00Z&limit=1000'
```

| Parameter | Meaning |
| --------- | ------- |
| `since` | An ISO 8601 time, with an offset or `Z`. Entries at or after it. From the start without it. |
| `limit` | 1 to 1000 entries. 100 without it. |

The answer is `{ "entries": [ ... ] }`, oldest first. Each entry carries
`id`, `ts`, `apiKeyId` (absent when no key asked), `action`, `outcome` and
`detail`. Any other query parameter answers 400 `invalid_request`.

To page, pass the `ts` of the last entry as the next `since`, and drop the
entries whose `id` you already hold. `since` is inclusive.

| `action` | `outcome` | `detail` |
| -------- | --------- | -------- |
| `lease` | `created` | `leaseId`, `feeUtxo`, `expiresAt` |
| `lease` | `released`, `expired` | `leaseId` |
| `lease` | `consumed`, `expired` when the pool sync closes a lease | `leaseId`, `reason` (`utxo_vanished` or `utxo_retired`), `utxo` |
| `lease` | `quota_exceeded` | `quota` (`open_leases`), `reason` |
| `lease` | `no_utxo_available`, `out_of_funds` | `reason` (`no_fee_utxo` or `no_collateral_utxo`) |
| `witness` | `issued` | `leaseId` or `mode: collateral`, `txHash`, `kind` (`creation` or `operation`), `sponsoredLovelace`, `fee` |
| `witness` | `reissued` | `leaseId` or `mode: collateral`, `txHash` |
| `witness` | a rule name, such as `evaluates` | `leaseId` or `mode: collateral`, `txHash`, `rule`, `reason` |
| `witness` | `quota_exceeded` | `leaseId` or `mode: collateral`, `txHash`, `quota` (`witnesses_per_hour` or `sponsored_lovelace_per_day`), `reason` |
| `witness` | `unknown_lease`, `lease_expired`, `lease_released`, `lease_consumed` | `leaseId`, `txHash`, `reason` |
| `witness` | `no_utxo_available`, `out_of_funds` | `leaseId` or `mode: collateral`, `txHash`, `reason` |
| `pool` | `restored` | `utxo`, `slot` |
| `pool` | `retired` | `utxo`, `kind`, `was`, `lovelace` |
| `pool` | `collateral_consumed` | `utxo`, `next` |
| `key` | `disabled` | `keyId`, `label` |

Issuing a key and replenishing are not on the audit trail. A rate limited
request is not either: it shows only as a 429 in the request log.

## What to watch

| Signal | Source | Expect | When it fires |
| ------ | ------ | ------ | ------------- |
| Free fee UTxOs | `pool.fee.free` on `/health` | Above the creations expected in flight | [No UTxO available](runbook.md#no-utxo-available) |
| Shared collateral | `pool.collateral.shared` on `/health` | `true` | [Out of funds](runbook.md#out-of-funds) or [no UTxO available](runbook.md#no-utxo-available) |
| Spare collateral | `pool.collateral.spare` on `/health` | 1 or more | Replenish, as [pool.md](pool.md#replenishing) describes |
| Consumed collateral | `pool.collateral.consumed` on `/health`, `collateral_consumed` on the audit trail | 0, and never rising | [The shared collateral is consumed](runbook.md#the-shared-collateral-is-consumed) |
| Reserve | `reserve.lovelace` on `/admin/pool` | Enough for the next replenish: the outputs it creates plus 3000000 lovelace | [Out of funds](runbook.md#out-of-funds) |
| Pool sync | `Pool sync failed` in the logs, `reserve.syncedAt` on `/admin/pool` | No failures, `syncedAt` under a minute old | [The provider is unreachable](runbook.md#the-provider-is-unreachable) |
| Quota exhaustion | `quota_exceeded` on the audit trail, by `apiKeyId` and `quota` | Rare | [A client key misbehaves](runbook.md#a-client-key-misbehaves) |
| Rate limiting | 429 answers in the request log | Rare | [A client key misbehaves](runbook.md#a-client-key-misbehaves) |
| Refusals | `witness` entries named after a rule | Few, spread over rules and keys | A burst of `evaluates` or `script_data_hash` across keys points at the provider. A burst of `known_logic` points at an upgrade window. |
| Unexpected errors | `Unhandled error` in the logs, 500 answers | None | Read the logged error. |
| Restarts | Container restarts and health status | None | [The service does not start](runbook.md#the-service-does-not-start) |
