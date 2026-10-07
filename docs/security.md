# Security

The service holds a funded Cardano wallet and signs transactions that
other people build. This document says who can ask it for what, what an
attacker can try, what each defence stops, what the sponsor can lose at
most, and how to run the service so that none of this is undone by its
surroundings.

## Who can call what

- Anyone can call `GET /health`. It reports the network and the pool
  counts, nothing that identifies a client or a UTxO.
- A client key, issued by an operator, can take and release leases, ask
  for witnesses on its own leases, read the shared collateral UTxO and
  ask for collateral witnesses. A lease belongs to the key that took it;
  another key sees it as unknown. A collateral witness belongs to no
  lease: it is keyed by the transaction it signs, and the same transaction
  presented again, by any key, receives the same signature, which
  authorises nothing the first one did not.
- The admin key can issue client keys, inspect and replenish the pool and
  read the audit trail. It cannot sign anything.
- No route exposes the mnemonic, a private key, a client key once issued,
  or a transaction body.

Keys are random 32 byte secrets, stored only as SHA-256 hashes and
compared in constant time; a forged, revoked or missing key is refused
with the same answer, so a caller learns nothing about which keys exist.

## What an attacker can try

### Draining the sponsor

A client that holds a lease can build any transaction it likes around the
leased fee UTxO and the shared collateral, and any client can present any
transaction to the collateral route. The transaction policy, applied in a
fixed order and documented rule by rule in the README, is what stops the
sponsor's value from going anywhere but the fee and the account:

- `uses_leased_fee_input` stops the transaction from spending any sponsor
  UTxO but the one leased, including the shared collateral used as a plain
  input, the reserve, and anything at the sponsor payment key elsewhere.
  In collateral mode `no_sponsor_inputs` refuses every sponsor input,
  the shared collateral included, so the only sponsor UTxO a transaction
  on that route touches is the collateral it declares.
- `uses_leased_collateral`, and `uses_shared_collateral` in collateral
  mode, keep the collateral exactly the shared UTxO, returned to the
  sponsor, and refuse a transaction that declares itself failing, which
  would forfeit the collateral outright.
- `account_transaction` and `no_foreign_scripts` make sure the only
  scripts that run are the account contract and the account's own stake
  script; a lookalike policy, a foreign script input or a foreign
  certificate is refused.
- `sponsor_outflow_bounded` ties what the fee UTxO is drawn down by to the
  fee, plus the registration deposit and the control output at creation,
  capped by `MAX_FEE_LOVELACE` and `MAX_SPONSORED_LOVELACE`; nothing is
  paid out to a third party and nothing comes back to the sponsor in a
  shape the pool cannot spend. In collateral mode `sponsor_outflow_zero`
  refuses any output to the sponsor payment key and any sponsor value
  entering the transaction, so the sponsor neither pays nor receives.
- `no_sponsor_value_elsewhere` checks that every output away from the
  sponsor and the account is covered by the non sponsor inputs.
- `signers` refuses anything the sponsor's signature would authorise
  beyond paying: required signers, withdrawals, certificates and votes
  naming a sponsor key. The witness set that leaves the service is checked
  to hold the sponsor payment key's signature and nothing else.

### Spending the collateral

Collateral is taken by the ledger only when a transaction fails phase two.
The `evaluates` rule has the provider resolve every input and evaluate
the transaction with the sponsor UTxOs it builds on supplied, and refuses
a redeemer that declares less budget than the evaluation found it needs,
so a witnessed transaction can only fail in phase one, which spends no
collateral. A transaction flagged as failing is refused outright. This is
what lets one collateral UTxO back every transaction at once, without a
lease: nothing the service signs can take it.

In collateral mode the shared collateral UTxO is the only sponsor value a
transaction touches at all, since every sponsor input and every output to
the sponsor is refused, so it is the only thing at risk on that route,
and only on a phase two failure the evaluation and budget rule prevents.
In either mode the loss, should this reasoning ever fail, is bounded by
what the UTxO holds, `COLLATERAL_UTXO_LOVELACE`, and happens once: the
pool sync marks the vanished UTxO consumed, records it on the audit trail,
designates the next free collateral UTxO, and the health endpoint reports
the count of consumed ones, so a failure of the reasoning is visible
rather than repeated. A transaction already signed against the old UTxO
cannot land once the chain has spent it, and the fee UTxO it
leased returns to the pool once its bound lapses, as any unsubmitted
witness does.

### Replaying a witness

A lease issues one witness and is consumed by it. The same transaction
presented again, even at the same moment, receives the same witness set
and counts once; a different transaction on a consumed lease is refused.
A collateral witness is keyed by the transaction it signs and is recorded
once, however many requests present the transaction at the same time. The
witness carries a signature over one transaction body, so it cannot be
moved to another transaction.

### Freezing the pool

A fee UTxO whose spend was witnessed cannot be leased again while that
transaction can still land. `bounded_validity` requires every witnessed
transaction to carry a validity upper bound later than the current slot
and no later than the slot of the lease expiry plus
`VALIDITY_MARGIN_SECONDS`, and the pool sync frees the UTxO once the
chain still lists it more than 120 slots after that bound, so a client
that obtains witnesses and never submits ties up a fee UTxO for the lease
TTL plus the margin plus those 120 slots, no longer. The bound is
compared as a slot number, never as a time, so a bound too large for any
calendar is refused like any other late one rather than slipping past a
comparison that cannot represent it; the expiry slot is found by counting
one second slots from the network's Shelley start, which is what preprod
and mainnet have had since. The service reads the current slot off its
own clock and trusts it to be within those 120 slots of the chain's.

A client that takes leases and never uses them holds each one for
`LEASE_TTL_SECONDS` at most, and at most `openLeases` of them at a time.
A client of the collateral route holds nothing: the shared collateral is
not reserved for it, and a collateral witness it never submits ties up no
UTxO, since the transaction spends none of the sponsor's. The bound such
a transaction must carry, `COLLATERAL_VALIDITY_SECONDS` from the time of
the request at most, keeps the signature from lingering all the same.

### Overspending a key's allowance

Each key has three quotas: `openLeases`, `witnessesPerHour` and
`sponsoredLovelacePerDay`. The witness quotas are checked before the
provider is called, so a key over quota costs nothing, and again inside
the step that records the witness, which is one database transaction, so
requests in flight at the same time cannot pass them together. Both modes
count against `witnessesPerHour`; a collateral witness sponsors zero
lovelace and adds nothing to the daily sponsored total.

### Flooding the service

Every request counts against its address's `IP_RATE_LIMIT_PER_MINUTE`,
before the body is read, so guessing keys or flooding costs the caller
its own address first. Every client route also counts against the key's
`KEY_RATE_LIMIT_PER_MINUTE`. Both answer 429 `rate_limited`. Request
bodies are capped at 64 KiB and transactions at 16 KiB, the protocol's
own limit, before anything decodes them. The inputs of a transaction are
resolved in one provider call, never one per input.

### Reading secrets out of the service

The mnemonic is read from `SPONSOR_MNEMONIC`, turned into a wallet and
wiped from the configuration and the process environment at startup. The
signing key stays inside the wallet; the service never writes it, logs
it or returns it. Logs redact the authorization header and any field
named after a mnemonic or a key, at the top of an entry or one level
down. Error responses never echo the
transaction; a policy refusal names the rule and the identifiers it
reasoned about, and an unexpected error answers a bare `internal_error`.
The database holds key hashes, UTxO references, transaction hashes and
witness sets, which are public keys and signatures; never a transaction
body or a secret.

### Chain reorganisations

The service never submits a transaction; the client does, and a
reorganisation is the client's to handle. The pool sync marks a fee UTxO
gone when it vanishes without a witness and restores it if the chain
shows it again, and marks it consumed when it vanishes after a witness,
which it stays while the witness can still land; once the chain shows it
again more than 120 slots past the bound of every witness on it, it is
leased again. A spare collateral UTxO that vanishes is marked gone, since
no witnessed transaction declares it, and is restored when it reappears;
the shared one is marked consumed, since only a phase two failure of a
witnessed transaction takes it, and is never designated again even if a
rollback brings it back, the next free collateral UTxO having taken its
place. A fee UTxO whose witnessed spend landed and was then rolled back is
held back only until that bound has passed; to release it sooner, spend
it from the sponsor wallet, as replenishing does, which invalidates the
signature for good. A replenish never spends the shared collateral UTxO,
whatever the reserve lists, so a transaction signed against it stays
valid for as long as its bound allows.

## What the sponsor can lose

- Per witnessed transaction: at most `MAX_SPONSORED_LOVELACE`, of which at
  most `MAX_FEE_LOVELACE` is the fee and the rest, at creation only, the
  registration deposit and the control output's lovelace, both of which
  end up in the account.
- Per key and day: at most `sponsoredLovelacePerDay`, enforced whatever
  the number of requests in flight.
- Per phase two failure the policy failed to foresee: at most
  `COLLATERAL_UTXO_LOVELACE`, the one shared collateral UTxO, which is
  all a transaction on the collateral route can touch.
- Everything in the pool and the reserve, if the mnemonic or the machine
  running the service is compromised. Keep the sponsor wallet small and
  top it up as it drains.

## Running the service

- Terminate TLS in front of the service; keys travel as bearer tokens.
  Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of proxies
  so the address rate limited is the client's, and never more, since a
  caller behind an over trusted hop could choose the address it is
  limited as.
- The mnemonic reaches the process only through its environment, as
  `SPONSOR_MNEMONIC`; the service reads it once at startup, derives the
  wallet, empties it from its configuration and removes it from the
  environment, and never writes it anywhere. A `.env` file in the working
  directory, which the service loads into its environment at startup, is
  an acceptable way to set it for a local run when the file is readable
  only by the service user, kept out of version control, as the
  repository's ignore rules do, and out of any image you build. In
  production prefer the
  supervisor's environment or a secret store, and keep the mnemonic out
  of shell histories and logs.
- Rotate `ADMIN_API_KEY` by changing the environment and restarting; it
  is not stored. Issue each client its own key with the quotas it needs,
  and disable a key by setting `disabled_at` on its row.
- Keep the pool small: a few fee UTxOs and a couple of collateral UTxOs,
  one shared and one spare, sized for the traffic expected, with the
  reserve holding what a replenish needs. The pool, not the reserve, is
  what a client can touch.
- Monitor `GET /health` for the free and leased fee counts, for whether a
  collateral UTxO is shared and how many spare ones remain, and for the
  consumed collateral count, which should stay at zero; read
  `GET /admin/audit` for what every key did; every lease, release,
  expiry, witness, refusal and consumed collateral is there, with the key
  that asked where one did.
- Run one process against one database; the lease and quota guarantees
  rest on sqlite transactions in that database.
