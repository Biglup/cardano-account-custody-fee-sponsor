# Configuration

The service reads its configuration from the environment once, at startup.
Before it reads, it loads a `.env` file from the working directory into the
environment. A variable already set in the environment takes precedence over
the same variable in the file. The container image carries no `.env` file; see
[deployment.md](deployment.md).

An invalid configuration stops the service before it listens. It prints
`Fee sponsor service failed to start: Invalid configuration:` on stderr,
followed by one line per variable at fault, and exits with code 1. Each line
names the variable and the reason, never the value.

## Variables

Every variable the code reads, in one table. "Secret" marks a value that
grants access or holds funds. Supply secrets from a secret store or the
supervisor's environment, and keep them out of shell histories, logs and
images.

| Variable | Required | Secret | Default | Accepted values | Effect |
| -------- | -------- | ------ | ------- | --------------- | ------ |
| `BLOCKFROST_PREPROD_PROJECT_ID` | Unless `PROVIDER_BASE_URL` is set | Secret | none | Any string. A blank value counts as unset. | The project id sent to the [provider](../glossary.md#provider). See [Reaching the chain](#reaching-the-chain). |
| `PROVIDER_BASE_URL` | No | Plain | The hosted Blockfrost preprod endpoint, `https://cardano-preprod.blockfrost.io/api/v0/` | A URL. A blank value counts as unset. | The Blockfrost compatible endpoint the service reads the chain through and submits its replenish through. |
| `SPONSOR_MNEMONIC` | Yes | Secret | none | 12, 15, 18, 21 or 24 words of lowercase ASCII letters, separated by whitespace | The [sponsor wallet](../glossary.md#sponsor-wallet). Whoever holds it holds the sponsor's funds. |
| `ACCOUNT_SCRIPT_HASH` | Yes | Plain | none | 56 lowercase hex characters | The hash of the account proxy. It must be the proxy of the blueprint at `BLUEPRINT_PATH`, or the service refuses to start. |
| `KNOWN_LOGIC_HASHES` | No | Plain | `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a` | A comma separated list of 56 lowercase hex characters per entry. Spaces around an entry and empty entries are ignored. At least one entry, none twice. | The [known logic](../glossary.md#known-logic) list that [POL-6](../policy.md#pol-6-known-logic) checks. |
| `ADMIN_API_KEY` | Yes | Secret | none | A non empty string | The [admin key](../glossary.md#admin-key), the bearer token of the `/admin` routes. |
| `PORT` | No | Plain | `8787` | An integer from 1 to 65535 | The port the service listens on, on every interface. |
| `DATABASE_PATH` | No | Plain | `./data/sponsor.sqlite` | A non empty path, relative to the working directory or absolute | The sqlite database file. The service creates the parent directory when it is missing. |
| `BLUEPRINT_PATH` | No | Plain | The `contract/plutus.json` shipped with the service, resolved from the installed code rather than the working directory | A non empty path | The contract blueprint the service reads the account proxy and the account stake validator from. |
| `LEASE_TTL_SECONDS` | No | Plain | `600` | A positive integer | How long a [lease](../glossary.md#lease) holds its fee UTxO. |
| `MAX_SPONSORED_LOVELACE` | No | Plain | `6000000` | A positive integer | The most one fee mode witness may draw from the sponsor, under [POL-7](../policy.md#pol-7-sponsor-outflow). A lease answer reports it as `maxSponsoredLovelace`. |
| `MAX_FEE_LOVELACE` | No | Plain | `2000000` | A positive integer | The largest fee a fee mode transaction may carry, under [POL-7](../policy.md#pol-7-sponsor-outflow). |
| `FEE_UTXO_LOVELACE` | No | Plain | `100000000` | A positive integer | The size of a [fee UTxO](../glossary.md#fee-utxo): what a replenish creates and what the pool sync classifies as one. |
| `COLLATERAL_UTXO_LOVELACE` | No | Plain | `5000000` | A positive integer | The size of a [collateral UTxO](../glossary.md#collateral-utxo), likewise. |
| `FEE_UTXO_COUNT` | No | Plain | `10` | A positive integer | The number of free and leased fee UTxOs a replenish tops the pool up to. |
| `COLLATERAL_UTXO_COUNT` | No | Plain | `2` | A positive integer | The number of free collateral UTxOs a replenish tops the pool up to, the shared collateral included. |
| `VALIDITY_MARGIN_SECONDS` | No | Plain | `120` | An integer of 0 or more | How far past the lease expiry a fee mode validity upper bound may reach, under [POL-4](../policy.md#pol-4-bounded-validity). |
| `COLLATERAL_VALIDITY_SECONDS` | No | Plain | `600` | A positive integer | How far from the time of the request a collateral mode validity upper bound may reach, under [POL-4](../policy.md#pol-4-bounded-validity). `GET /v1/collateral` reports it as `validitySeconds`. |
| `IP_RATE_LIMIT_PER_MINUTE` | No | Plain | `120` | A positive integer | Requests per client address per minute, on every route. |
| `KEY_RATE_LIMIT_PER_MINUTE` | No | Plain | `60` | A positive integer | Requests per [client key](../glossary.md#client-key) per minute, on the `/v1` routes. |
| `TRUST_PROXY_HOPS` | No | Plain | `0` | An integer of 0 or more | The number of reverse proxies in front of the service. See [deployment.md](deployment.md#tls-and-the-client-address). |
| `SPONSOR_SERVICE_URL` | No | Plain | none | A URL. A blank value counts as unset. Trailing slashes are dropped. | Read by the preprod proof only. See [CONTRIBUTING.md](../../CONTRIBUTING.md#the-preprod-proof). |
| `SPONSOR_SERVICE_API_KEY` | With `SPONSOR_SERVICE_URL` | Secret | none | Any string. A blank value counts as unset. | Read by the preprod proof only, likewise. |

## Rules across variables

- `BLOCKFROST_PREPROD_PROJECT_ID` or `PROVIDER_BASE_URL` must be set.
- `FEE_UTXO_LOVELACE` and `COLLATERAL_UTXO_LOVELACE` must differ by more than
  10 percent of the larger. The pool sync classifies a UTxO by which size it
  lies within a tenth of, so closer sizes cannot be told apart.
- `SPONSOR_SERVICE_URL` and `SPONSOR_SERVICE_API_KEY` are set together or not
  at all.
- Leave a variable out rather than set it blank. Only the four variables the
  table marks treat a blank value as unset. A blank numeric value reads as 0,
  which most variables refuse and `VALIDITY_MARGIN_SECONDS` and
  `TRUST_PROXY_HOPS` accept.

## Checks at startup

After the configuration parses, the service refuses to start when:

- the mnemonic does not derive a wallet;
- the blueprint at `BLUEPRINT_PATH` cannot be read, lacks the account proxy or
  the account stake validator, or holds a proxy that does not hash to
  `ACCOUNT_SCRIPT_HASH`. The message names both hashes;
- the stake validator in the blueprint is not a Plutus program;
- the database belongs to another sponsor address. The message names the last
  eight characters of both addresses;
- the first [pool sync](../glossary.md#pool-sync) fails, which is what an
  unreachable provider causes.

[runbook.md](runbook.md#the-service-does-not-start) says what to do about
each.

Once the wallet is derived, the service empties the mnemonic from its
configuration. It also removes `SPONSOR_MNEMONIC`,
`BLOCKFROST_PREPROD_PROJECT_ID` and `ADMIN_API_KEY` from its process
environment.

## Reaching the chain

The service reaches preprod through one Blockfrost compatible endpoint in one
of two ways.

| Endpoint | `PROVIDER_BASE_URL` | `BLOCKFROST_PREPROD_PROJECT_ID` |
| -------- | ------------------- | ------------------------------- |
| The hosted Blockfrost preprod endpoint | unset | the Blockfrost project id |
| A Blockfrost compatible endpoint that supplies its own credentials, such as a proxy | the endpoint's base URL | unset |

A Blockfrost compatible endpoint that needs a project id takes both variables.
With a project id set, the service sends it in the `project_id` header. With
none set, it sends no `project_id` header at all. An endpoint that injects its
own key may refuse a header that is present but blank.

A proxy that routes by path, such as the Lace Blockfrost proxy, serves several
networks and applications from one host. Its operators allocate each
application a route prefix, the surface. The service uses the preprod route of
its surface:

```
PROVIDER_BASE_URL=https://<proxy host>/<surface>/preprod/api/v0
```

The service sends every request to the base URL followed by a single slash and
the route, such as `<base>/tx/submit`. It never sends a doubled slash, which a
proxy that routes by path may refuse.

The service works on preprod only. The endpoint must serve preprod. The
network magic and the slot settings are fixed to preprod in code. The service
does not detect an endpoint that serves another chain. On a chain whose slots
map to time differently, every validity bound the service checks is wrong.

[threat-model.md](../security/threat-model.md#trusting-the-provider) says how
far to trust the endpoint.

## Values fixed in code

These are not configurable. Neither are the
[restore margin](../glossary.md#restore-margin) and the default
[quotas](../glossary.md#quota) of a client key, which the glossary states.

| Value | Setting |
| ----- | ------- |
| Network | preprod |
| Slot settings | slot 86400 at 2022-06-21T00:00:00Z, one second per slot |
| Sponsor wallet derivation | account 0, payment index 0, stake index 0 |
| Pool sync interval | 30 seconds |
| Lease expiry sweep interval | 30 seconds |
| Pool classification tolerance | a tenth of each pool size |
| Replenish fee margin | 3000000 lovelace kept back from the reserve |
| Replenish confirmation wait | 180 seconds |
| JSON request body limit | 64 KiB |
| Transaction size limit | 16 KiB, under [POL-1](../policy.md#pol-1-well-formed) |
| Audit page size | 100 entries by default, 1000 at most |
