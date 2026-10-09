# Known issues

Residual risks and limitations of the service. Each entry says what the
limitation is, what it affects and how an operator lives with it.
[threat-model.md](threat-model.md) explains the defences these sit beside.

The service has not had an external security audit.

## Policy

### A logic withdrawal that draws lovelace is refused

[POL-9](../policy.md#pol-9-no-foreign-scripts) refuses a withdrawal that runs
a known logic and draws a non zero amount. The ledger requires a withdrawal
to draw the reward account's whole balance. A third party can credit a
logic's reward account without consent, for example by naming it as the
reward account of a stake pool registration. Once that balance is non zero,
every transaction of every account under that logic must draw it. The
service then refuses all of them, creations and operations alike.

The drawn lovelace enters the transaction and is not the sponsor's, so
admitting it costs the sponsor nothing. Accounts under an affected logic
cannot use the service.

### A provider failure answers as a refusal

A witness request during a provider failure can answer as a refusal of the
transaction. [runbook.md](../operators/runbook.md#the-provider-is-unreachable)
lists the answers.

### Refusals are explained in prose only

A refusal carries the rule name and a free text `detail`. The offending
input, output, credential or amount is not a field of its own. The service
also does not report its contract build, its known logic, or its caps beyond
`maxSponsoredLovelace` in a lease answer.

## Trust and reach

### The provider is trusted

The evaluation verdict, the cost models and the view of every input come from
one provider. A provider that lies can cost the sponsor the shared collateral
or the lovelace of one creation. See
[threat-model.md](threat-model.md#trusting-the-provider).

### Refused requests are not counted against a quota

The witness quotas count issued witnesses. A request the policy refuses
still costs provider calls: input resolution, the protocol parameters and an
evaluation. A key can make up to `KEY_RATE_LIMIT_PER_MINUTE` such requests a
minute. Against a provider with a request quota of its own, one key can spend
that quota. Lower `KEY_RATE_LIMIT_PER_MINUTE`, and disable a key whose
refusals repeat, as [runbook.md](../operators/runbook.md#a-client-key-misbehaves)
describes.

### Preprod only

See [configuration.md](../operators/configuration.md#reaching-the-chain).

### The service clock sets the current slot

See [deployment.md](../operators/deployment.md#clock).

## Operation

### One wallet, one process, one database

The service holds one sponsor wallet at one address. One process serves one
database, as [deployment.md](../operators/deployment.md#state) describes.
There is no horizontal scaling and no failover. The rate limit counters live
in the process's memory. They reset on restart.

### The admin routes share the client port

`/admin` is served on the same port as `/health` and `/v1`. Keeping it off
the public network is the reverse proxy's job. See
[deployment.md](../operators/deployment.md#keep-the-admin-routes-off-the-public-network).

### One admin key, partly audited

All operators share one admin key, and the audit trail records no operator
identity. [monitoring.md](../operators/monitoring.md#the-audit-trail) says
what else the audit trail leaves out.

### Quotas are fixed at issuance

See [runbook.md](../operators/runbook.md#change-a-keys-quotas).

### A disabled key's witnesses stay valid

See [runbook.md](../operators/runbook.md#disable-a-client-key).

### Health does not track the provider

See [monitoring.md](../operators/monitoring.md#the-health-route).

### No graceful shutdown

On SIGTERM the process ends at once. Requests in flight are dropped. A
database transaction in flight is rolled back. A replenish already submitted
may still land, and the next pool sync takes up its outputs.

### A consumed shared collateral is never reused

A shared collateral marked consumed stays consumed, even when a rollback
brings it back. Reclaim it by hand, as
[runbook.md](../operators/runbook.md#the-shared-collateral-is-consumed)
describes.

### Changing a pool size retires witnessed fee UTxOs

A fee UTxO whose witnessed transaction has not landed is retired like any
other when a pool size changes. A replenish may then spend it and invalidate
that transaction. See [pool.md](../operators/pool.md#changing-the-pool-sizes).

### One schema

The database schema is created by a single migration. The service converts
no other schema. A database file with another schema must be replaced.
