# Deployment

The service ships as a container image. This document covers the image, how
to run it, and how to expose it. [configuration.md](configuration.md) lists
the variables it reads. [runbook.md](runbook.md) covers the situations an
operator handles once it runs.

## The image

The image is `ghcr.io/biglup/cardano-account-custody-fee-sponsor`, built for
`linux/amd64` and `linux/arm64`.

| Property | Value |
| -------- | ----- |
| Base | Node 22 on Debian bookworm slim, pinned by digest. |
| Contents | The compiled service, its production dependencies, and the blueprint of the contract build it serves at `/app/contract/plutus.json` |
| Process | `/usr/bin/tini -g -- node dist/main.js`, so tini is process 1 and forwards signals to node |
| User | `nonroot`, uid and gid 60000 |
| Port | 8787 |
| Volume | `/data` |
| Environment | `DATABASE_PATH=/data/sponsor.sqlite` and `PORT=8787`, nothing else |
| Logs | JSON lines on stdout. [monitoring.md](monitoring.md#logs) lists the lines to watch. |

The image carries no `.env` file and no secret. The service reads everything
else from the container's environment and refuses to start without a required
variable.

Leave `DATABASE_PATH` as the image sets it, or name another file under
`/data`. Leave `BLUEPRINT_PATH` unset: its default is the blueprint the image
ships.

## Tags

| Build | Tags |
| ----- | ---- |
| A commit on `main` | `<YYYYMMDD>.<n>_<hash>`: the UTC day of the commit, its rank among that day's commits on `main`, and its short hash. The newest is also `latest`. |
| A repository tag `vX.Y.Z` | `vX.Y.Z`, `vX.Y` and `vX`. A pre-release tag, such as `vX.Y.Z-rc.1`, is published under its full version only. |

Only commits on `main` and version tags are published. Pull requests build
the image and publish nothing.

### Pin by digest

A tag can move. A digest names one image. Pin a deployment to a version, and
preferably to that version's digest, never to `latest`.

```sh
docker buildx imagetools inspect ghcr.io/biglup/cardano-account-custody-fee-sponsor:vX.Y.Z
```

The `Digest:` line is the digest of the multi platform index. Deploy it as:

```
ghcr.io/biglup/cardano-account-custody-fee-sponsor@sha256:<digest>
```

### The contract build an image serves

Each image serves one build of the account custody contract: the blueprint
under `/app/contract/plutus.json`. `ACCOUNT_SCRIPT_HASH` must name that
build's account proxy. This prints the proxy hash of an image's blueprint:

```sh
docker run --rm --interactive --entrypoint node <image> - <<'EOF'
const { readFileSync } = require('node:fs');
const Cometa = require('@biglup/cometa');
Cometa.ready().then(() => {
  const { validators } = JSON.parse(readFileSync('contract/plutus.json', 'utf8'));
  const proxy = validators.find((validator) => validator.title.startsWith('account.account.'));
  console.log(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: proxy.compiledCode, version: Cometa.PlutusLanguageVersion.V3 }));
});
EOF
```

A service started with any other `ACCOUNT_SCRIPT_HASH` refuses to start and
names both hashes.

## State

The sqlite database at `/data/sponsor.sqlite` is the service's only state. It
holds the client key hashes and their quotas, the pool, the leases, the
witnesses and the audit trail. It runs in write ahead log mode, so it lives
in three files: `sponsor.sqlite`, `sponsor.sqlite-wal` and
`sponsor.sqlite-shm`.

Mount a named volume at `/data`, or a host directory writable by uid 60000.
The database is bound to the sponsor address the mnemonic derives. It serves
that one sponsor wallet only.

Run one process against one database. The lease and quota guarantees rest on
sqlite transactions in that database. Never start two containers on the same
volume.

[runbook.md](runbook.md#back-up-and-restore-the-database) covers backup and
restore.

## Running with docker

Put the variables in an environment file readable by the supervisor only, one
unquoted `VARIABLE=value` per line. Pass it to the container:

```sh
docker run --detach --name sponsor \
  --env-file /etc/sponsor/env \
  --volume sponsor-data:/data \
  --publish 127.0.0.1:8787:8787 \
  --restart unless-stopped \
  ghcr.io/biglup/cardano-account-custody-fee-sponsor@sha256:<digest>
```

Publishing on the loopback address keeps the service reachable only through a
reverse proxy on the same host. See
[Exposing the service](#exposing-the-service).

### First start

1. Start the container. Once it listens, it logs `Fee sponsor service
   listening` with the sponsor address in the `address` field.
2. Fund the sponsor address. The funds land in the
   [reserve](../glossary.md#reserve).
3. Replenish the pool, as [pool.md](pool.md#replenishing) describes.
4. Check that `GET /health` reports free fee UTxOs and `"shared": true`.
5. Issue each client its own key, as
   [runbook.md](runbook.md#issue-a-client-key) describes.

### Changing the configuration

The container reads the environment file only when it is created.
`docker restart` keeps the environment the container was created with. To
apply a change to the file, recreate the container:

```sh
docker stop sponsor
docker rm sponsor
```

Then run it again with the `docker run` command above. The volume keeps the
database. With compose, `docker compose up -d` recreates the container when
`.env` changes.

## Health check

The image declares a health check. It calls `GET /health` every 30 seconds,
with a 5 second timeout, after a 30 second start period, and marks the
container unhealthy after 3 failures in a row.

The route answers once the service has derived the sponsor wallet, synced the
pool through the provider and started listening. A service that cannot reach
its provider at startup never listens. It exits with code 1, and the restart
policy starts it again. [monitoring.md](monitoring.md#the-health-route) says
what a 200 does and does not mean.

## Running with compose

`docker-compose.yml` runs the service from a checkout, for local use. It
builds the image from the `Dockerfile` and reads the checkout's `.env`. It
overrides `DATABASE_PATH` and `PORT` with the image's values, keeps the
database on the named volume `sponsor-data`, and publishes port 8787 on the
loopback address only. It caps the container log at two files of 30 MB.

```sh
docker compose up --build
```

A deployment runs the published image, pinned by digest, not the compose
file.

## Exposing the service

### TLS and the client address

The service speaks plain HTTP. Client keys and the admin key travel as bearer
tokens, so terminate TLS in a reverse proxy in front of it.

The address rate limit applies to the client address. Behind reverse proxies,
set `TRUST_PROXY_HOPS` to the number of proxies, and never more. The service
then reads the client address from that many `X-Forwarded-For` hops. Trusting
more hops than exist lets a caller choose the address it is limited as. With
`TRUST_PROXY_HOPS` at 0, the service limits each request by the address of its
connection. If the first request after start carries an `X-Forwarded-For`
header, the service prints one `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` message on
stderr. The request is still served. The message points at a proxy in front of
a service that does not trust it. The check runs on the first request only, so
a missing message proves nothing.

### Keep the admin routes off the public network

The service serves `/health`, `/v1` and `/admin` on one port. The admin routes
issue client keys, read the audit trail and spend the reserve. Forward only
`/health` and `/v1/` from the public side, and reach `/admin` from the host or
a private network. An nginx sketch, with one proxy hop:

```nginx
location = /health {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /v1/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location / {
    return 404;
}
```

With this proxy, set `TRUST_PROXY_HOPS=1`. An operator then reaches the admin
routes on `127.0.0.1:8787`, for example through an SSH tunnel to the host.

### Clock

The service reads the current slot off its own clock. Keep the host clock
disciplined with NTP. [threat-model.md](../security/threat-model.md#freezing-the-pool)
explains what a clock ahead of the chain affects.

## Upgrading the service

1. Pull the new version and note its digest.
2. Check that its contract build is the one `ACCOUNT_SCRIPT_HASH` names, as
   [above](#the-contract-build-an-image-serves). When it is not, follow
   [runbook.md](runbook.md#the-contract-build-changes).
3. Back up the database.
4. Stop the old container and start the new one on the same volume, with the
   same environment file.

The database schema is applied at startup. The pool sync reconciles the pool
with the chain on the first run, so nothing has to be resynced by hand.
