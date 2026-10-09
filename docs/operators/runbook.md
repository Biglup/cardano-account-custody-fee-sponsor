# Runbook

Routine tasks and common situations, each with how to diagnose it and what to
do. [monitoring.md](monitoring.md) lists the signals that lead here.

The commands assume a shell on the service host, with the container named
`sponsor`, the admin routes on the loopback address and the admin key in the
shell's environment:

```sh
SPONSOR=http://127.0.0.1:8787
read -rs ADMIN_API_KEY
```

`read -rs` keeps the key out of the shell history and off the screen.

## Routine tasks

### Issue a client key

```sh
curl --silent --request POST "$SPONSOR/admin/keys" \
  --header "Authorization: Bearer $ADMIN_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{ "label": "my dapp", "quotas": { "witnessesPerHour": 30 } }'
```

`label` is 1 to 100 characters. `quotas` is optional and may set any of
`openLeases`, `witnessesPerHour` and `sponsoredLovelacePerDay` as positive
integers. The rest take the [default quotas](../glossary.md#quota). The answer
is 201 with `apiKey`, `id`, `label` and the effective `quotas`.

The service shows `apiKey` once and stores only its SHA-256 hash. Hand it to
the client over a channel fit for a secret. Size `witnessesPerHour` as
[pool.md](pool.md#sizing) describes.

### List client keys

```sh
curl --silent --header "Authorization: Bearer $ADMIN_API_KEY" "$SPONSOR/admin/keys"
```

The answer lists every key ever issued, oldest first, with `id`, `label`,
`quotas`, `createdAt` and `disabledAt`, never the key or its hash.

### Change a key's quotas

Quotas are fixed when a key is issued. Issue a new key with the new quotas,
hand it over, then disable the old one.

### Disable a client key

```sh
curl --silent --request DELETE --header "Authorization: Bearer $ADMIN_API_KEY" "$SPONSOR/admin/keys/<id>"
```

Every later request with the key answers 401 `unauthorized`. The
disablement is a `key` `disabled` audit entry. Disabling a key already
disabled answers 200 and keeps the first time. The key's open leases expire
by themselves within `LEASE_TTL_SECONDS`. A witness it already obtained stays
valid until its validity upper bound, which
[POL-4](../policy.md#pol-4-bounded-validity) limits.

### Rotate the admin key

The service does not store `ADMIN_API_KEY`. Change it in the environment file
and recreate the container, as
[deployment.md](deployment.md#changing-the-configuration) describes.

## Out of funds

Symptoms:

- 503 `out_of_funds` on a lease, on `GET /v1/collateral`, on a witness route
  or on a replenish;
- `out_of_funds` entries on the audit trail;
- `/health` reports no free fee UTxO or `"shared": false`.

Diagnose: the `detail` of the answer says what the reserve holds and what a
split needs, which is the output size plus 3000000 lovelace. `GET
/admin/pool` shows the reserve and the time of the last pool sync.

Act:

1. Find the sponsor address in the `address` field of the
   `Fee sponsor service listening` log line, or in the `sponsorAddress` of a
   lease or collateral answer.
2. Fund it, and wait for the funding transaction to confirm.
3. Replenish, as [pool.md](pool.md#replenishing) describes.
4. Check that `/health` reports free fee UTxOs and `"shared": true`.

## No UTxO available

Symptoms: 409 `no_utxo_available` on a lease, on `GET /v1/collateral` or on a
witness route.

Diagnose by the `detail`:

| Detail | Cause |
| ------ | ----- |
| `All N fee UTxOs are leased; the soonest lease expires at T` | Demand exceeds the pool, or a key holds many leases. Group the `lease` `created` audit entries by `apiKeyId`. |
| `The pool has no fee UTxO yet; ...` | No fee UTxO is free or leased. Either the pool was never replenished, or every fee UTxO is consumed and waiting for its witnesses to lapse. |
| `The pool has no collateral UTxO yet; ...` | No shared collateral is designated and none is free. |

The first row answers `no_utxo_available` whatever the reserve holds. In the
other two rows the reserve can fund a split. When it cannot, the answer is
`out_of_funds` instead.

Act:

1. Replenish, as [pool.md](pool.md#replenishing) describes. By default a
   replenish tops the free and leased fee UTxOs up to `FEE_UTXO_COUNT`. When
   the leased ones alone reach that count, it creates no fee UTxO. Pass an
   explicit `feeUtxoCount` in the request instead, or raise
   `FEE_UTXO_COUNT` as the next step says.
2. When demand stays above the pool, raise `FEE_UTXO_COUNT` and recreate the
   container, as [deployment.md](deployment.md#changing-the-configuration)
   describes.
3. When one key holds the pool, follow
   [A client key misbehaves](#a-client-key-misbehaves).

## The shared collateral is consumed

Symptoms:

- `pool.collateral.consumed` on `/health` rises;
- a `Shared collateral consumed` log line;
- a `pool` `collateral_consumed` audit entry with the consumed `utxo` and its
  replacement `next`.

The policy keeps a witnessed transaction from failing in phase two, so this
is a security event. Diagnose:

1. Look up the transaction that spent `utxo` on a preprod explorer.
2. Search the audit trail for a `witness` `issued` entry with that `txHash`.
   - Found: a witnessed transaction failed phase two. Its entry names the key.
     The provider's evaluation disagreed with the chain, or the policy missed
     a case. Read [threat-model.md](../security/threat-model.md#spending-the-collateral).
   - Not found: something else holding the sponsor key spent it. Treat the
     mnemonic as compromised.
3. When no transaction spent it, the provider listed the address without it,
   through a rollback or a faulty answer. Nothing was lost.

Act:

1. When `next` is null, `/health` reports `"shared": false`. Replenish
   collateral, as [pool.md](pool.md#replenishing) describes.
2. Disable the key that obtained the failing witness.
3. When the mnemonic may be compromised, move the funds to a new sponsor
   wallet and redeploy with its mnemonic and a new database.

A consumed shared collateral stays consumed even when a rollback brings it
back. To reclaim it, spend it from the sponsor wallet by hand. Spent alone,
its change lands within a tenth of the collateral size, and the next pool
sync takes it up as a free collateral UTxO. Merged with other value, it lands
in the reserve.

## The provider is unreachable

Symptoms:

- `Pool sync failed` in the logs every 30 seconds, and `reserve.syncedAt` on
  `/admin/pool` stops moving;
- witness requests refused under `evaluates`, with `The inputs could not be
  resolved` or `The transaction does not evaluate`, or under
  `script_data_hash`, with `The script data hash cannot be computed`;
- 500 `internal_error` on a lease or a replenish that needs a pool sync;
- 500 `internal_error` on `GET /v1/collateral` and on both witness routes
  when no shared collateral is designated. Each then runs a pool sync, which
  fails;
- at startup, `Fee sponsor service failed to start: <reason>` and repeated
  restarts.

A client cannot tell a refusal under `evaluates` or `script_data_hash` caused
by the outage from a truly invalid transaction, other than by its `detail`.
`/health` does not show the outage, as
[monitoring.md](monitoring.md#the-health-route) explains.

Diagnose from the host, with the endpoint the service uses:

```sh
curl --silent --include --header "project_id: <project id>" \
  https://cardano-preprod.blockfrost.io/api/v0/blocks/latest
curl --silent --include "$PROVIDER_BASE_URL/blocks/latest"
```

Use the first form for the hosted endpoint and the second for a proxy. A 403
points at the project id. A 402 or 429 points at the provider's own request
quota. No answer points at the network or the endpoint.

Act: fix what the check points at. Nothing in the service needs resetting.
The next pool sync after the provider answers resumes normal operation. A
client whose witness request was refused presents the transaction again. In
fee mode its lease stays open until it expires.

## The service does not start

The stderr line `Fee sponsor service failed to start: <reason>` names the
cause.

| Reason | Act |
| ------ | --- |
| `Invalid configuration:` and one line per variable | Fix each variable named. See [configuration.md](configuration.md). |
| `Failed to derive the sponsor wallet from SPONSOR_MNEMONIC` | The words do not form a valid mnemonic. Check the value in the secret store. |
| `The blueprint at <path> cannot be read`, `is not an Aiken blueprint`, `has no validator titled` | `BLUEPRINT_PATH` points at the wrong file. Unset it in the container. |
| `The stake validator in the blueprint at <path> is not a Plutus program` | The blueprint is damaged or is not a contract build. When `BLUEPRINT_PATH` is set, unset it in the container. When it is unset, the image's own blueprint is at fault: deploy another image. |
| `The blueprint at <path> is a build whose account proxy hashes to X, not to the Y that ACCOUNT_SCRIPT_HASH names` | The image serves another contract build. See [The contract build changes](#the-contract-build-changes). |
| `The database belongs to the sponsor address ending in A ... but SPONSOR_MNEMONIC derives one ending in B` | The mnemonic or the volume is the wrong one. Restore the matching pair. Never delete the database to get past this. |
| A provider error | See [The provider is unreachable](#the-provider-is-unreachable). |
| An sqlite error opening `/data/sponsor.sqlite` | The volume is not writable by uid 60000. Fix its ownership. |

## The contract build changes

Each image serves one contract build, and `ACCOUNT_SCRIPT_HASH` must name its
account proxy. A build with another proxy governs a different set of
accounts. One service serves one proxy.

1. Choose the image whose blueprint is the build to serve. Print its proxy
   hash, as [deployment.md](deployment.md#the-contract-build-an-image-serves)
   shows.
2. Read the build's logic versions in the contract's
   [architecture](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/architecture.md#upgrades),
   and the hash of each applied to the new proxy.
3. Set `ACCOUNT_SCRIPT_HASH` to the new proxy hash. Set `KNOWN_LOGIC_HASHES`
   explicitly to the logic versions of that build: its default is one logic
   applied to one proxy.
4. Deploy the image, as [deployment.md](deployment.md#upgrading-the-service)
   describes.

The database carries over: it is bound to the sponsor address, not to the
build. After the switch, transactions on accounts of the old proxy are
refused under [POL-5](../policy.md#pol-5-account-transaction). To serve two
builds at once, run two services, each with its own sponsor wallet and its
own database.

## An upgrade window

An account moves to another logic version by writing the new logic into its
control output. The upgrade transaction names both the logic it leaves and
the logic it reaches, and [POL-6](../policy.md#pol-6-known-logic) requires
both to be [known logic](../glossary.md#known-logic). The contract's
[architecture](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/architecture.md#upgrades)
describes upgrades.

1. Read the new logic version. Name a hash only after reading the version it
   stands for, and only as that version applied to `ACCOUNT_SCRIPT_HASH`.
2. Before any account upgrades, list both hashes and recreate the
   container, as [deployment.md](deployment.md#changing-the-configuration)
   describes:

   ```
   KNOWN_LOGIC_HASHES=<old logic hash>,<new logic hash>
   ```

3. Keep both while any account still names the old logic. An account that
   has not moved runs the old logic. A moved account runs the new one.
4. Once no account names the old logic, list the new hash alone and recreate
   the container.
   A `known_logic` refusal naming the old hash afterwards shows an account
   still on it.

Taking a hash off the list stops the service serving every account under
it. Their transactions are refused under `known_logic`. This is the answer to
a logic version found wanting.

## A client key misbehaves

Symptoms: `quota_exceeded` or many refusals on the audit trail for one
`apiKeyId`, 429 answers from one address, or fee UTxOs held by one key.

Diagnose on the audit trail, by `apiKeyId`:

- `lease` `created` without a matching `witness` `issued` holds fee UTxOs
  until the leases expire;
- `witness` `issued` whose `txHash` never appears on chain holds fee UTxOs
  until the witnesses lapse;
- refusals under the same rule, again and again, probe the policy.

Act: disable the key. Issue a new one with tighter quotas when the client is
legitimate. When a key has leaked, disable it at once.

## Back up and restore the database

The database is the only state. What the chain holds survives without it: the
first pool sync on an empty database finds the fee and collateral UTxOs again.
What only the database holds does not survive: the client keys and their
quota usage, the open leases, the witnesses and the audit trail.

### Back up while the service runs

The database runs in write ahead log mode. A plain copy of
`sponsor.sqlite` alone can miss committed transactions held in
`sponsor.sqlite-wal`. Take an online backup through sqlite instead:

```sh
docker exec sponsor node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/sponsor.sqlite');
db.backup('/data/sponsor-backup.sqlite').then(() => db.close());
"
docker cp sponsor:/data/sponsor-backup.sqlite "sponsor-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker exec sponsor rm /data/sponsor-backup.sqlite
```

The result is one self contained database file.

### Back up while the service is stopped

Copy `sponsor.sqlite`, `sponsor.sqlite-wal` and `sponsor.sqlite-shm`
together:

```sh
docker stop sponsor
docker run --rm --user 0 --entrypoint tar \
  --volume sponsor-data:/data:ro --volume "$PWD":/backup \
  <image> -C /data -cf /backup/sponsor-data.tar .
docker start sponsor
```

### Restore

Restore a backup only for the sponsor wallet it was taken from. The service
refuses a database of another sponsor address.

1. Stop the service.
2. Replace `/data/sponsor.sqlite` with the backup. Delete
   `sponsor.sqlite-wal` and `sponsor.sqlite-shm`, or restore all three files
   from the same archive. A log file left over from another database corrupts
   the restored one.
3. Make the files owned by uid and gid 60000.

   Steps 1 to 3 from an online backup:

   ```sh
   docker stop sponsor
   docker run --rm --user 0 --entrypoint sh \
     --volume sponsor-data:/data --volume "$PWD":/backup:ro \
     <image> -c 'rm -f /data/sponsor.sqlite /data/sponsor.sqlite-wal /data/sponsor.sqlite-shm \
       && cp /backup/<backup file> /data/sponsor.sqlite \
       && chown 60000:60000 /data/sponsor.sqlite'
   ```

   Steps 1 to 3 from an archive taken while the service was stopped:

   ```sh
   docker stop sponsor
   docker run --rm --user 0 --entrypoint sh \
     --volume sponsor-data:/data --volume "$PWD":/backup:ro \
     <image> -c 'rm -f /data/sponsor.sqlite /data/sponsor.sqlite-wal /data/sponsor.sqlite-shm \
       && tar -C /data -xf /backup/sponsor-data.tar \
       && chown -R 60000:60000 /data'
   ```

4. Start the service no sooner than `LEASE_TTL_SECONDS` plus
   `VALIDITY_MARGIN_SECONDS` plus the
   [restore margin](../glossary.md#restore-margin) after the old service
   stopped. A witness the
   backup does not record has lapsed by then. Starting earlier lets the pool
   lease a fee UTxO that such a witness still spends, and one of the two
   transactions fails.

After the restore:

- keys issued after the backup answer 401. Issue them again;
- quota usage since the backup is forgotten;
- the first pool sync reconciles the pool with the chain.

The same rules apply when the database is lost and the service starts on an
empty volume: wait the same time, then issue every client a new key.
