# Glossary

The terms of the fee sponsor service, in alphabetical order. Terms of the
account custody contract, such as account, control UTxO, state NFT, grant,
grant UTxO, proxy, logic, stake script, reserve, creation, agent key signer
and fee sponsor, are defined in the
[contract glossary](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/glossary.md).

### Account script address

An address whose payment credential is `ACCOUNT_SCRIPT_HASH`, with any stake
part or none. It is broader than the contract's
[account address](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/glossary.md#account-address),
which also carries the account's own stake script as its stake credential.

### Admin key

The bearer token set in `ADMIN_API_KEY`. It authorizes the `/admin` routes:
issuing, listing and disabling client keys, reading the pool and the audit
trail, and replenishing. It obtains no witness for a client transaction.

### Audit trail

The record the service keeps of these events:

- a lease created, released, expired or consumed, and a lease refused under a
  quota, or for want of a fee UTxO or of the shared collateral;
- a witness issued or issued again, and a witness refused, with what refused
  it and the refusal's reason;
- a client key disabled, with the key's label;
- a pool UTxO retired, a consumed fee UTxO restored, and the shared
  collateral consumed.

Entries carry identifiers, amounts and reasons, never a transaction body or a
key. They are read through `GET /admin/audit`.

### Client adapter

`SponsorWallet`, exported by the package. It implements cometa's `Wallet`
interface over the API in fee mode or collateral mode, so the contract's
transaction builders use the service as a wallet. It reports a refusal as a
`SponsorError` carrying `status`, `code`, `rule` and `detail`.

### Client key

A bearer token the admin key issues to one client. It authorizes the `/v1`
routes, carries the client's quotas and is stored only as its SHA-256 hash.

### Collateral mode

The mode of `POST /v1/collateral/witness`. The sponsor lends the shared
collateral to any account transaction that takes no sponsor value, a creation
the client funds itself included. It contributes no input and no output. No
lease is involved.

### Collateral UTxO

A pool UTxO holding only lovelace, within a tenth of
`COLLATERAL_UTXO_LOVELACE`. One is the shared collateral; the others are spare
collateral.

### Creation

The contract's
[creation](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/glossary.md#creation).
Fee mode pays for creations only.

### Fee mode

The mode of `POST /v1/leases/:id/witness`. The leased fee UTxO pays for an
account creation. [POL-7](policy.md#pol-7-sponsor-outflow) states what it may
be drawn down by.

### Fee UTxO

A pool UTxO holding only lovelace, within a tenth of `FEE_UTXO_LOVELACE`. A
lease reserves one for a single client.

### Known logic

A logic script hash listed in `KNOWN_LOGIC_HASHES`. The service refuses a
transaction that names any other logic.

### Lapsed witness

A witness whose validity upper bound the current slot has passed by more than
the [restore margin](#restore-margin). No block can include its transaction
any more.

### Lease

A client key's exclusive reservation of one fee UTxO for `LEASE_TTL_SECONDS`.
A lease is open, released by its client, consumed by the one witness it
issues, or expired.

### Operation

An account transaction that spends a control UTxO or a grant UTxO of an
existing account. Fee mode refuses operations. Collateral mode serves them, and
creations too.

### Policy

The ordered rules a transaction must pass before the service signs it. See
[policy.md](policy.md).

### Pool

The fee UTxOs and collateral UTxOs at the sponsor address that the service
tracks. Each has a status: free, leased, consumed, gone or retired.

### Pool size

`FEE_UTXO_LOVELACE` or `COLLATERAL_UTXO_LOVELACE`. The pool sync classifies a
UTxO that holds only lovelace, within a tenth of one of these sizes, as a fee
UTxO or a collateral UTxO. Every other UTxO at the sponsor address is reserve.

### Pool sync

The reconciliation of the pool with the chain, at startup and every 30
seconds. It lists the sponsor address through the provider, classifies each
UTxO by size, and settles UTxOs that vanished, reappeared or no longer match a
pool size.

### Provider

The Blockfrost compatible endpoint the service reads the chain through. It
resolves inputs, evaluates transactions and reports the protocol parameters.

### Quota

A limit on one client key: open leases, witnesses per hour and sponsored
lovelace per day. The defaults are 5, 60 and 600 tADA.

### Refusal

A `422 invalid_transaction` answer. Its `rule` names the first policy rule the
transaction breaks and its `detail` says how.

### Replenish

A transaction from the sponsor wallet to itself that splits the reserve into
fee UTxOs and collateral UTxOs. It spends the reserve only.

### Reserve

The sponsor's UTxOs outside the pool: every UTxO at the sponsor address that
matches neither pool size or carries tokens. It is never leased. It is not the
contract's
[reserve](https://github.com/Biglup/cardano-account-custody-contract/blob/main/docs/glossary.md#reserve).

### Restore margin

120 slots. A consumed fee UTxO that the chain still lists returns to the pool
once the current slot is more than this past the validity upper bound of every
witness issued on it.

### Rule

One named check of the policy. Its name is what a refusal reports in `rule`.

### Shared collateral

The one collateral UTxO that every witnessed transaction declares, in both
modes. When none is designated, the pool sync designates the oldest free
collateral UTxO. The designation holds while the UTxO stays free, that is,
while the chain lists it at a collateral size. It is never leased.

### Spare collateral

A free collateral UTxO that is not the shared collateral. The pool sync
designates the oldest one when the shared collateral is consumed or retired.

### Sponsor address

The base address of the sponsor wallet, with key hash payment and stake
credentials. Fee UTxOs, collateral, change and collateral returns sit there.

### Sponsor payment key

The payment key of the sponsor wallet. Its hash is the payment credential of
the sponsor address. Every witness is its signature.

### Sponsor stake key

The stake key of the sponsor wallet. Its hash is the stake credential of the
sponsor address. No witness carries its signature.

### Sponsor UTxO

An input the pool tracks, whatever its status, or an input locked by the
sponsor payment key at any base, enterprise or pointer address.

### Sponsor wallet

The single wallet the service derives from `SPONSOR_MNEMONIC`, at account 0,
payment index 0 and stake index 0. The database is bound to its address.

### Sponsored lovelace

What a witnessed transaction draws from the sponsor. In fee mode it is the
leased fee UTxO's lovelace less the change returned to the sponsor address; in
collateral mode it is zero. It counts against the daily quota.

### Validity upper bound

The slot from which a transaction is no longer valid. The policy requires one
and bounds it in each mode, as [POL-4](policy.md#pol-4-bounded-validity)
states.

### Witness

The sponsor payment key's signature over one transaction body, returned as a
witness set in CBOR hex holding that signature alone. The same transaction
presented again receives the same witness set.
