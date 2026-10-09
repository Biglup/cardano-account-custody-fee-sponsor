# Security

Each heading below names a security topic and the document that covers it,
so links to these headings resolve.

## Who can call what

See [threat-model.md](security/threat-model.md#who-can-call-what).

## What an attacker can try

See [threat-model.md](security/threat-model.md). Each defence is a rule of
the [policy](policy.md).

### Draining the sponsor

See [threat-model.md](security/threat-model.md#draining-the-sponsor) and the
rules of [policy.md](policy.md).

### Spending the collateral

See [threat-model.md](security/threat-model.md#spending-the-collateral),
[ADR 0001](adr/0001-shared-collateral-without-a-lease.md) and
[ADR 0003](adr/0003-verify-the-script-data-hash.md).

### Trusting the provider

See [threat-model.md](security/threat-model.md#trusting-the-provider).

### Replaying a witness

See [threat-model.md](security/threat-model.md#replaying-a-witness).

### Freezing the pool

See [threat-model.md](security/threat-model.md#freezing-the-pool) and
[pool.md](operators/pool.md#sizing).

### Overspending a key's allowance

See [threat-model.md](security/threat-model.md#overspending-an-allowance).

### Flooding the service

See [threat-model.md](security/threat-model.md#flooding-the-service).

### Reading secrets out of the service

See [threat-model.md](security/threat-model.md#reading-secrets).

### Chain reorganisations

See [threat-model.md](security/threat-model.md#chain-reorganisations).

## What the sponsor can lose

See [threat-model.md](security/threat-model.md#what-the-sponsor-can-lose).

## Running the service

- TLS, the client address and the admin routes:
  [deployment.md](operators/deployment.md#exposing-the-service).
- The mnemonic and the other secrets:
  [configuration.md](operators/configuration.md#variables).
- Client keys and the admin key:
  [runbook.md](operators/runbook.md#routine-tasks).
- Known logic and upgrade windows:
  [runbook.md](operators/runbook.md#an-upgrade-window).
- Pool size: [pool.md](operators/pool.md#sizing).
- What to watch: [monitoring.md](operators/monitoring.md#what-to-watch).
- One process against one database:
  [deployment.md](operators/deployment.md#state).

The risks that remain are in
[known-issues.md](security/known-issues.md).
