# Documentation

Every document of the fee sponsor service, grouped by reader, with its
purpose. The [repository README](../README.md) is the entry point.

## Integrators

For teams whose wallet or app obtains the sponsor's signature.

| Document | Purpose |
| -------- | ------- |
| [overview.md](overview.md) | What the service is, where it sits, its two modes, and what it signs and never signs. |
| [integrators/quickstart.md](integrators/quickstart.md) | A first sponsored creation and a collateral mode spend, with the client adapter. |
| [integrators/flows.md](integrators/flows.md) | Who builds, signs and submits in each mode, and the lifecycle of a lease. |
| [integrators/api.md](integrators/api.md) | Every route: authentication, bodies, statuses, quotas and rate limits. |
| [integrators/errors.md](integrators/errors.md) | Every error code, its cause and its fix, and every refusal by rule. |
| [integrators/retries-and-idempotency.md](integrators/retries-and-idempotency.md) | Which requests are safe to repeat, and what to do when a lease expires or the shared collateral changes. |
| [integrators/client-adapter.md](integrators/client-adapter.md) | `SponsorWallet`, the cometa `Wallet` over the API, and `SponsorError`. |
| [glossary.md](glossary.md) | The terms of the service, each defined once. |

## Operators

For the people who run an instance.

| Document | Purpose |
| -------- | ------- |
| [operators/configuration.md](operators/configuration.md) | Every environment variable, the checks at startup, and how the service reaches the chain. |
| [operators/deployment.md](operators/deployment.md) | The container image and its tags, the database, and how to expose the service. |
| [operators/pool.md](operators/pool.md) | Fee UTxOs, collateral UTxOs and the reserve: classification, lifecycle, replenishing and sizing. |
| [operators/monitoring.md](operators/monitoring.md) | The health route, the log lines and the audit trail, and what to watch. |
| [operators/runbook.md](operators/runbook.md) | Routine tasks and incidents, each with its diagnosis and its fix. |

## Auditors

For anyone who assesses what the service signs and why.

| Document | Purpose |
| -------- | ------- |
| [policy.md](policy.md) | The rules a transaction must pass before it is signed, POL-1 to POL-12, in the order they are checked. |
| [security/threat-model.md](security/threat-model.md) | The assets, the trust assumptions, each attack and the defence against it, and what the sponsor can lose. |
| [security/known-issues.md](security/known-issues.md) | The risks and limitations that remain. |
| [verification.md](verification.md) | How the service is verified, and what is not verified. |
| [adr/0001-shared-collateral-without-a-lease.md](adr/0001-shared-collateral-without-a-lease.md) | Why one collateral UTxO backs every transaction without a lease. |
| [adr/0002-fee-mode-for-creation-only.md](adr/0002-fee-mode-for-creation-only.md) | Why a leased fee UTxO pays for account creations only. |
| [adr/0003-verify-the-script-data-hash.md](adr/0003-verify-the-script-data-hash.md) | Why the service recomputes the script data hash before it evaluates. |
| [adr/0004-creation-must-derive-from-a-listed-device.md](adr/0004-creation-must-derive-from-a-listed-device.md) | Why a creation's stake credential must derive from a device its state lists. |
| [preprod-hosted-evidence.md](preprod-hosted-evidence.md) | Generated record of a custody account taken through its life against the hosted instance. |
| [preprod-evidence.md](preprod-evidence.md) | Generated record of a run against a service the proof started itself, under another contract build. |
| [security.md](security.md) | A map from the security headings that external links name to the documents above. |

## Contributors

For anyone who builds or changes the service.

| Document | Purpose |
| -------- | ------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Requirements, setup, commands, the sibling contract checkout, the image and the preprod proof. |
