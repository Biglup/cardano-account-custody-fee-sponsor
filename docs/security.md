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
- The admin key can issue, list and disable client keys, inspect and
  replenish the pool and read the audit trail. It cannot sign anything.
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
  input, the sponsor's reserve, which is the wallet's UTxOs outside the
  pool and not an account's reserve under the contract, and anything at
  the sponsor payment key elsewhere.
  In collateral mode `no_sponsor_inputs` refuses every sponsor input,
  the shared collateral included, so the only sponsor UTxO a transaction
  on that route touches is the collateral it declares.
- `uses_shared_collateral` keeps the collateral exactly the shared UTxO
  in both modes, returned to the sponsor, and refuses a transaction that
  declares itself failing, which would forfeit the collateral outright.
- `account_transaction` and `no_foreign_scripts` make sure the only
  scripts that run are the account proxy, the account's own stake script
  and the logic holding the account's rules; a lookalike policy, a
  foreign script input or a foreign certificate is refused. The account
  a transaction operates is read from the control or grant UTxOs it
  spends, which hold a token of the account policy at the address the
  token is named after, and its stake script from the control UTxO it
  spends or, as an agent spend does, references. A creation's stake
  credential must be the contract's own stake script applied to one of
  the devices its control output lists and to `ACCOUNT_SCRIPT_HASH`,
  which the service derives itself from the stake validator in the
  blueprint at `BLUEPRINT_PATH` and keeps per device key: the proxy
  mints the state NFT for any script credential, so without this a
  client could register an always true script of its own as the
  credential, write whatever state it liked into the control output and
  have the sponsor pay the fee, the deposit and the control output for an
  account none of the contract's owner guarantees hold for. A datum
  listing more than the eight devices a well formed state carries is
  refused before anything is derived, so a client cannot make the
  service derive without bound. A grant UTxO spent
  without its account's control UTxO, a referenced control UTxO of an
  account no input operates, a token of the account policy held at the
  sponsor address, which the sponsor input rules refuse first, and a
  grant shaped token under any other policy are all refused.
- A reference input is never read as an input. The proxy and the logic
  are usually parked in UTxOs at an address nobody can spend from and
  referenced rather than carried, so a reference input at a foreign
  address is allowed; it is read as neither the sponsor's nor an
  account's, it names no stake script and no logic, and a UTxO holding
  an account token counts as a control UTxO only at the account address
  its token names. A sponsor UTxO among the reference inputs takes
  nothing from the sponsor, and the same UTxO among the inputs is still
  refused by the sponsor input rules, which read a sponsor payment
  credential at any address. An upgrade cannot embed both logics, since
  two logic scripts and the proxy exceed the transaction size limit the
  first rule enforces, so an upgrade references parked copies of the
  logics; the policy reads which logics it names from the control datums
  all the same, never from the parked UTxOs.
- `known_logic` keeps the sponsor out of accounts whose rules it has not
  read. The proxy holds no rules of its own: it runs the logic script
  the control datum names, and it admits whatever hash that datum
  carries, so a device that signs an upgrade to an unknown logic hands
  its account to code nobody vetted. Every logic a transaction names,
  in the datum of each control UTxO it spends or references and of each
  control output it writes, must be one `KNOWN_LOGIC_HASHES` lists; a
  control datum with no script hash in that field is refused too. The
  sponsor neither pays the fee of nor lends collateral to such a
  transaction, so an unknown logic can neither spend sponsor lovelace
  nor put the shared collateral at risk. The list defaults to
  `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a`, the one
  version every account is created under and runs.
- `no_foreign_scripts` lets only the proxy lock an input or mint, since
  the stake validator has only withdraw and publish handlers. It admits
  a logic the transaction names in two places and nowhere else: as a withdrawal credential, since the zero
  withdrawal from the logic's reward account is how the proxy runs the
  account's rules, and an upgrade names two, the logic it leaves and the
  one it arrives at; and as an attached Plutus script, which is how a
  transaction that embeds the logic rather than referencing a parked
  copy carries it. Only a control UTxO's datum or a control output's
  makes a logic allowed there; referencing the UTxO a logic is parked at
  does not, and a logic is admitted neither as the payment credential of
  an input, nor as a mint policy, nor on a certificate or a vote. A
  withdrawal that names a logic and draws any lovelace is refused, which
  is stricter than the contract and safe: the logic credential is never
  delegated, so its reward balance stays zero and the ledger never needs
  a non zero draw. A second withdrawal from a reward account already
  drawn from is refused as well, since no ledger decodes such a map.
- `sponsor_outflow_bounded` lets a leased fee UTxO pay for an account
  creation and for nothing else: an operation on an existing account is
  refused on the fee route whatever it draws, so the sponsor's exposure
  in fee mode is to creations alone. It ties what the fee UTxO is drawn
  down by to the fee, the registration deposit and the control output,
  capped by `MAX_FEE_LOVELACE` and `MAX_SPONSORED_LOVELACE`; nothing is
  paid out to a third party and what comes back to the sponsor is one
  change output in a shape the pool can spend, never change fragmented
  into UTxOs the pool would classify as reserve. In collateral mode `sponsor_outflow_zero`
  refuses any output to the sponsor payment key and any sponsor value
  entering the transaction, so the sponsor neither pays nor receives.
- `no_sponsor_value_elsewhere` checks that every output away from the
  sponsor and the account is covered by the non sponsor inputs.
- `script_data_hash` ties what is evaluated to what the body commits to:
  the redeemers and the datums the witness set carries must hash, under
  the cost models the provider reports, to the script data hash in the
  body, which is the field the sponsor's signature covers.
- `signers` refuses anything the sponsor's signature would authorise
  beyond paying: required signers, withdrawals, certificates and votes
  naming a sponsor key. The witness set that leaves the service is checked
  to hold the sponsor payment key's signature and nothing else.

### Spending the collateral

Collateral is taken by the ledger only when a transaction fails phase two.
The `evaluates` rule has the provider resolve every input and reference
input and evaluate the transaction with the sponsor UTxOs it builds on
supplied, and refuses
a redeemer that declares less budget than the evaluation found it needs,
so a witnessed transaction can only fail in phase one, which spends no
collateral. A transaction flagged as failing is refused outright. This is
what lets one collateral UTxO back every transaction at once, without a
lease: nothing the service signs can take it. The rule is load bearing
against path confusion inside the contract as well: the structural rules
do not tell the proxy's owner path, a control UTxO spent under the
device redeemer, from its agent path, a grant UTxO spent under the grant
redeemer with the control UTxO referenced, so a transaction that mixes
the two is refused only by the scripts themselves running here.

Evaluation alone does not establish that, because the sponsor signs a
body and the scripts run on a witness set. The redeemers and the datums
live in the witness set, which no signature covers: anyone may strip
them, replace them or add to them after the fact without touching the
body or invalidating the sponsor's signature. What ties the two together
is the script data hash, which sits in the body and so is covered by the
signature, and which the ledger recomputes from the redeemers, the
datums and the cost models of the languages the transaction's scripts
are written in, refusing in phase one any transaction whose witness set
does not hash to it.

An evaluation endpoint, however, judges the witness set in front of it
and ignores the hash the body carries, since a builder cannot know that
hash until the budgets are final. So evaluating one set of redeemers
says nothing about the set the body commits to. A client that builds a
body committing to script data it never shows, attaches honest redeemers
to be evaluated, obtains the signature and then swaps in the data the
body always committed to hands the ledger a transaction that passes
phase one, since the attached data now matches the hash, and runs
scripts nobody evaluated; redeemers under declaring their budgets then
fail phase two and forfeit the shared collateral.

The `script_data_hash` rule closes this, immediately before evaluation.
The hash is recomputed from the witness set as it stands, over the
redeemers, the datums when the transaction carries any, and the language
view built from the cost models the provider reports, and anything but
an exact match with the body's field is refused: other script data than
the body commits to, a body committing to none while the witness set
carries redeemers or datums, and a body committing to one while it
carries neither. Only Plutus V3 scripts run under the account contract,
so a transaction whose scripts are not all written in it is refused here
rather than hashed under a guessed language view. What is then evaluated
is the only script data the signed body will accept, which is what makes
the evaluation binding.

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

### Trusting the provider

The chain is read and evaluated through one Blockfrost compatible
endpoint, which may be the hosted one or a proxy another team runs, and
the service trusts what it answers. Three guarantees rest on it: the
`evaluates` rule takes the endpoint's evaluation as the phase two
verdict, the `script_data_hash` rule takes its cost models as the prices
the chain charges, and the rules that classify inputs take its view of
what every input holds and who it pays. An endpoint that lies or that
serves a stale view can therefore cost the sponsor two things: the
shared collateral UTxO, if it reports an evaluation the chain then fails,
bounded by `COLLATERAL_UTXO_LOVELACE` and visible on the audit trail and
in health; and the lovelace of one creation, if it fabricates a UTxO view
the exact outflow check is then measured against. It cannot obtain a
signature over a transaction the service did not inspect, because the
structural rules read the transaction itself and the witness set is
checked before it leaves. Point the service only at an endpoint trusted
as much as the wallet it holds.

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
A client that obtains witnesses and never submits holds more: each
witnessed fee UTxO is held for the lease TTL plus the margin plus the
restore slots, fourteen minutes with the defaults, and a key may take a
fresh witness on it as soon as it returns. With the defaults, one key at
60 witnesses per hour can hold the ten default fee UTxOs out of the pool
by never submitting, for about two hours: every fee mode witness is a
creation, which sponsors up to `MAX_SPONSORED_LOVELACE`, until the daily
sponsored lovelace quota ends it. Size `witnessesPerHour` against
`FEE_UTXO_COUNT` for each key:
holding one fee UTxO continuously takes about four witnesses per hour at
the default TTL and margin, so a key allowed fewer than four times
`FEE_UTXO_COUNT` witnesses per hour cannot freeze the pool by itself,
and the audit trail shows a key whose witnesses never land.
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
own limit, before anything decodes them. The inputs and the reference
inputs of a transaction are resolved in one provider call, never one per
input.

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

- Per witnessed transaction in fee mode, which is always an account
  creation: at most `MAX_SPONSORED_LOVELACE`, of which at most
  `MAX_FEE_LOVELACE` is the fee and the rest the registration deposit and
  the control output's lovelace, both of which end up in the account. A
  witness in collateral mode sponsors nothing.
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
  and disable a key through `DELETE /admin/keys/:id`, which refuses
  every later request with it and is written to the audit trail.
- Name a logic in `KNOWN_LOGIC_HASHES` only after reading the version it
  stands for, and only as the hash of that version applied to
  `ACCOUNT_SCRIPT_HASH`. The list is what keeps the sponsor out of
  accounts under rules nobody vetted. Taking a hash off the list stops
  the service serving the accounts under it: their transactions are
  refused under `known_logic` and those accounts pay their own way from
  then on, which is the intended answer to a logic found wanting.
- Should the contract gain a version accounts move to, keep both
  versions on the list while the upgrade window is open. The upgrade
  transaction runs the version an account leaves and the one it arrives
  at, and every account that has not moved keeps running the old one, so
  the version left is what the upgrade itself needs and the version
  arrived at is what the moved accounts need. Drop the old hash only once
  no account still names it.
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
