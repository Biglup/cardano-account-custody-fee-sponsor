# Preprod evidence, hosted service

A custody account taken through its life on preprod on 2026-10-09T02:52:43.649Z with the hosted fee sponsor service at https://sponsor-preprod.lw.iog.io as the only source of
sponsor funds and collateral. The service ran elsewhere with a sponsor wallet of its own, the run reached it with a client
key its operator issued and called no admin route,
and every transaction was built through the contract's own builders with the sponsor wallet adapter:
in fee mode as the `sponsor` of the creation, where the service paid the fee, the registration deposit and the control
UTxO for an owner wallet that holds no ADA, and in collateral mode as the `collateral` wallet of every later operation,
where the account paid its own fee, the owner operations from a reserve UTxO the owner alone can spend and the agent
spend from the plain funds, and the service contributed the shared collateral and nothing else. The grant lived in its
own grant UTxO and the agent spend referenced the control UTxO without spending it. The owner and the agent wallets held
no ADA at any point.

## Setup

- Service: the hosted instance at https://sponsor-preprod.lw.iog.io, reached with a client key its operator issued; no admin route was called
- Pool readings: `GET /health`, which answers without a key; the pool is the operator's to replenish and the audit trail the operator's to read
- Sponsor address, as the service reported it in its lease and collateral answers: `addr_test1qr6zc7szyt85kpmxyayldq4mh8943tvmhyfxhfkrhh38fhrneh9p20y8997andynf2t4p5dhzeu5c3n68wv62yy5g5eq7t620f`
- Account proxy hash: `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253`
- Logic script hash: `2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a`, which every transaction but a plain deposit ran through a withdrawal of zero
- Reference scripts: 2 parked on the network and referenced rather than carried
- Pool before the run, as `GET /health` reported it: 99 free fee UTxOs, 0 leased, one shared collateral UTxO and 3 spare
- No replenishment: a client of the service cannot replenish it
- Pool after the run, as `GET /health` reported it: 99 free fee UTxOs, 0 leased, one shared collateral UTxO and 3 spare
- Owner wallet: account index 10 of the funding mnemonic, address `addr_test1qz0cu29rsq8cez2rl7rxqr8z6tmlkz3l5ve623qrvhtq09xa824n3hycqvfg22ypser2y4r2cujx3xngpqvavy67s65s0flzg0`, holding no ADA
- Owner key hash: `9f8e28a3800f8c8943ff86600ce2d2f7fb0a3fa333a5440365d60794`
- Agent wallet: account index 11 of the funding mnemonic, address `addr_test1qz4apvttzhehq4fa87e9azk8hgc5g5t5j0u5kxznzh7ftsgldrtwgr3k569rhrd3zr6ylp0d6eahf40pcxgt5vnepx6s3xa3vv`, holding no ADA
- Agent key hash: `abd0b16b15f370553d3fb25e8ac7ba3144517493f94b185315fc95c1`
- Recipient address: account index 12 of the funding mnemonic, `addr_test1qpp4faeqyz9ta8q9f5ggt2d0hlmgcz9vmnv4ee4p4swcluu6t7t8ypeq6myvt00cje22ccgkhdwecmy334x3mmzkzhpsp64hx9`, the third party the account pays
- Account address: `addr_test1xrkkr936e9x39s9nyzl95vmvx6hkd0qzcwqwp23sqxyey573kexdjalu7emmg3yhd0atze4x0l8gq0v5z8mp63gpqnsqweqvt5`
- Stake credential: `d1b64cd977fcf677b444976bfab166a67fce803d9411f61d450104e0`, reward address `stake_test17rgmvnxewl70vaa5gjtkh743v6n8ln5q8k2prasag5qsfcqg4tr5q`
- State NFT: `ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253d1b64cd977fcf677b444976bfab166a67fce803d9411f61d450104e0`

## 1. Sponsored account creation, fee mode

- Lease `01b8506b-e224-4fa4-aab9-7811c1cc3a09`, expiring 2026-10-09T02:55:56.985Z: fee UTxO `3332fd3f2b4e94c3376fb145df5c1087e77887c89df46b9a8660f97922195b89#0` of 100000000 lovelace (100.000000 tADA),
  shared collateral UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA)
- Validity upper bound: slot 135831356, the lease expiry, as the adapter presets it
- Transaction: [a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6](https://preprod.cardanoscan.io/transaction/a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6), signed by the owner device and the service

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 481761 lovelace (0.481761 tADA) | the sponsor |
| Stake registration deposit | 2000000 lovelace (2.000000 tADA) | the sponsor |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the sponsor |
| Sponsor change | 95518239 lovelace (95.518239 tADA) | |
| Sponsored in total | 4481761 lovelace (4.481761 tADA) | the sponsor |

The fee UTxO held 100000000 lovelace (100.000000 tADA); the change back to the sponsor leaves exactly the fee, the deposit and the
control UTxO sponsored, which is what the sponsor outflow rule requires of a creation.

On chain after confirmation:

- The control UTxO `a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6#0` sits at the account address holding 2000000 lovelace (2.000000 tADA) and the state NFT
- The stake credential is registered: Blockfrost lists the reward address as registered, active from the next epoch
- The sponsor change UTxO `a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6#1` holds 95518239 lovelace (95.518239 tADA)
- The audit trail is the operator's to read and was not read

## 2. Deposit and reserve

- Transaction: [8a45044e837228e3c4c5287ea447ff498aed39fb18040b076af77dea0742d236](https://preprod.cardanoscan.io/transaction/8a45044e837228e3c4c5287ea447ff498aed39fb18040b076af77dea0742d236), a plain transfer of 50000000 lovelace (50.000000 tADA) to the account address and a deposit of
  20000000 lovelace (20.000000 tADA) under the reserve datum, which the owner alone can spend
- Paid by the funding wallet, account 0 of the funding mnemonic, from its UTxOs outside the pool sizes, with a fee of 171793 lovelace (0.171793 tADA);
  the service was not involved and no pool UTxO was touched

## 3. Owner spend from the reserve, collateral mode

5000000 lovelace (5.000000 tADA) paid from the account to the recipient address through `spendWithDevice`, with the adapter in collateral mode as
the builder's `collateral` wallet. The fee is drawn from the reserve, which is spent and recreated with the fee taken out, so
that no fund UTxO an agent may be spending is touched.

- Transaction: [a192ac1f68c0fbaf534f0f0834bd087d8d4999b0fe769e3ff3806f6d60c6c377](https://preprod.cardanoscan.io/transaction/a192ac1f68c0fbaf534f0f0834bd087d8d4999b0fe769e3ff3806f6d60c6c377), signed by the owner device and the service
- Validity upper bound: slot 135831399, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA), total collateral 741992 lovelace (0.741992 tADA),
  collateral return of 4258008 lovelace (4.258008 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 494661 lovelace (0.494661 tADA) | the account, from its reserve |
| Paid away from the account | 5000000 lovelace (5.000000 tADA) | the account |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the account, including any growth |
| Grant UTxOs | 0 lovelace (0.000000 tADA) | the account |
| Reserve recreated with | 19505339 lovelace (19.505339 tADA) | the fee taken out of it |
| Change back to the account | 45000000 lovelace (45.000000 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 4. Grant issued into its own UTxO, collateral mode

A lovelace grant in slot 0 to the agent key through `issueGrant`: 10000000 lovelace (10.000000 tADA) per call, 10000000 lovelace (10.000000 tADA) in total,
expiring at 2026-10-09T04:48:32.146Z, the recipient address as the only recipient. The grant token is minted into
a grant UTxO at the account address, paid from the funds, under generation 0; the fee
comes from the reserve, and the control UTxO's next slot and outstanding count move to one.

- Transaction: [5f559c14d517d89c7989137fea96e127ccd61369cf31bb0f7003e52ae94de40a](https://preprod.cardanoscan.io/transaction/5f559c14d517d89c7989137fea96e127ccd61369cf31bb0f7003e52ae94de40a), signed by the owner device and the service
- Validity upper bound: slot 135831452, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA), total collateral 846318 lovelace (0.846318 tADA),
  collateral return of 4153682 lovelace (4.153682 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 564212 lovelace (0.564212 tADA) | the account, from its reserve |
| Paid away from the account | 0 lovelace (0.000000 tADA) | the account |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the account, including any growth |
| Grant UTxOs | 1943810 lovelace (1.943810 tADA) | the account |
| Reserve recreated with | 18941127 lovelace (18.941127 tADA) | the fee taken out of it |
| Change back to the account | 43056190 lovelace (43.056190 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 5. Agent spend within the cap, collateral mode

3000000 lovelace (3.000000 tADA) paid from the account to the recipient address through `spendWithGrant`, built from the persisted account
record with the agent wallet signing and the adapter in collateral mode as the builder's `collateral` wallet. The grant UTxO
is spent and recreated with the same value, the control UTxO is referenced and left alone, and the fee comes out of the
plain funds and counts against the grant alongside the payout: the caps are reduced by the payout plus the fee bound of
1.5 tADA, which the validator accepts anywhere between zero and the exact reduction.

- Transaction: [078533aa3a6503fdc2acaf0c722f1a5c6f8c7c475982d67c7fa5338ef83f57b5](https://preprod.cardanoscan.io/transaction/078533aa3a6503fdc2acaf0c722f1a5c6f8c7c475982d67c7fa5338ef83f57b5), signed by the agent key and the service
- Validity upper bound: slot 135831265, set by the builder's validUntilSlot, 300 slots ahead
- Collateral: the shared UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA), total collateral 767333 lovelace (0.767333 tADA),
  collateral return of 4232667 lovelace (4.232667 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 511555 lovelace (0.511555 tADA) | the account, from its funds |
| Paid away from the account | 3000000 lovelace (3.000000 tADA) | the account |
| Control UTxO | referenced, not spent | |
| Grant UTxOs | 1943810 lovelace (1.943810 tADA) | the account |
| Reserve | not spent | |
| Change back to the account | 39544635 lovelace (39.544635 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

- Remaining cap after the spend: 5500000 lovelace (5.500000 tADA)

## 6. Agent spend over the cap, refused

8000000 lovelace (8.000000 tADA) to the recipient address through `spendWithGrant` built without the builder's checks, so that the validator is
the one to refuse it. The service evaluated the transaction through the provider before signing, the evaluation failed in
phase two, and the service refused it under `evaluates` without signing. Its hash is `4867f4458a3fecc536f0690d1c24d13e88f5950e566f87aa8ab5c6eda607042e`; it was never submitted.

1. The agent spend over the cap, presented to the collateral witness route: HTTP 422

   ```json
   {
     "error": "invalid_transaction",
     "rule": "evaluates",
     "detail": "The transaction does not evaluate: evaluateTransaction: Blockfrost endpoint returned evaluation failure: {\"EvaluationFailure\":{\"ScriptFailures\":{}}}"
   }
   ```

## 7. Grant revoked, collateral mode

The grant in slot 0 revoked through `revokeGrant`: the slot joins the revoked list of the control UTxO, which now lists
0, and the grant UTxO is left in place, dead.

- Transaction: [54b7d6fc231858f69446cfb278659f4305b3f89f4e0a886720b9c59d4cd7bd8a](https://preprod.cardanoscan.io/transaction/54b7d6fc231858f69446cfb278659f4305b3f89f4e0a886720b9c59d4cd7bd8a), signed by the owner device and the service
- Validity upper bound: slot 135831582, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA), total collateral 703356 lovelace (0.703356 tADA),
  collateral return of 4296644 lovelace (4.296644 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 468904 lovelace (0.468904 tADA) | the account, from its reserve |
| Paid away from the account | 0 lovelace (0.000000 tADA) | the account |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the account, including any growth |
| Grant UTxOs | 0 lovelace (0.000000 tADA) | the account |
| Reserve recreated with | 18472223 lovelace (18.472223 tADA) | the fee taken out of it |
| Change back to the account | 0 lovelace (0.000000 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 8. Dead grant swept, collateral mode

The dead grant UTxO of slot 0 swept through `sweepGrant`: its token is burned and its lovelace returns to the account, leaving
0 grants outstanding and 0 grant UTxOs at the address.

- Transaction: [4bdc74f740122d1d1263b7206b5b7b37114bd5a7b79ccca0d857037fb3344573](https://preprod.cardanoscan.io/transaction/4bdc74f740122d1d1263b7206b5b7b37114bd5a7b79ccca0d857037fb3344573), signed by the owner device and the service
- Validity upper bound: slot 135831676, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `3ff950e4702fe04b846ddb9c2fd11fd085331a1a1fbf72837f1f25e1d297d0b4#10` of 5000000 lovelace (5.000000 tADA), total collateral 812043 lovelace (0.812043 tADA),
  collateral return of 4187957 lovelace (4.187957 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 541362 lovelace (0.541362 tADA) | the account, from its reserve |
| Paid away from the account | 0 lovelace (0.000000 tADA) | the account |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the account, including any growth |
| Grant UTxOs | 0 lovelace (0.000000 tADA) | the account |
| Reserve recreated with | 17930861 lovelace (17.930861 tADA) | the fee taken out of it |
| Change back to the account | 1943810 lovelace (1.943810 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 9. Refused creations, fee mode

A second creation, for the owner at account index 12 (`addr_test1qpp4faeqyz9ta8q9f5ggt2d0hlmgcz9vmnv4ee4p4swcluu6t7t8ypeq6myvt00cje22ccgkhdwecmy334x3mmzkzhpsp64hx9`), built with a sponsor wallet
that slips a 5000000 lovelace (5.000000 tADA) payment to the first owner's address into every builder, so that the creation
also pays sponsor value to a third party. Its hash is
`2101998717156c0962b90d8d3b3140195c3729c440071c94cde9231f92768cf9`; it was never submitted.

1. The creation paying sponsor value to a third party, on a fresh lease: HTTP 422

   ```json
   {
     "error": "invalid_transaction",
     "rule": "sponsor_outflow_bounded",
     "detail": "The sponsor input is drawn down by 9487424 lovelace but the fee, the registration deposit and the control output account for 4487424"
   }
   ```

2. The same transaction presented on the lease the creation consumed: HTTP 409

   ```json
   {
     "error": "lease_consumed",
     "detail": "Lease 01b8506b-e224-4fa4-aab9-7811c1cc3a09 already issued a witness"
   }
   ```

## Who paid what

| Step | Transaction | Fee | Fee paid by | Sponsor lovelace spent | Sponsor part |
| ---- | ----------- | --- | ----------- | ---------------------- | ------------ |
| 1 | [a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6](https://preprod.cardanoscan.io/transaction/a49f2509cb32981a362200f05128242cd9a889e76373746eac6f5879d1ec53b6) | 481761 lovelace (0.481761 tADA) | the sponsor | 4481761 lovelace (4.481761 tADA) | fee, deposit, control UTxO and collateral |
| 2 | [8a45044e837228e3c4c5287ea447ff498aed39fb18040b076af77dea0742d236](https://preprod.cardanoscan.io/transaction/8a45044e837228e3c4c5287ea447ff498aed39fb18040b076af77dea0742d236) | 171793 lovelace (0.171793 tADA) | the funding wallet | none through the service | none |
| 3 | [a192ac1f68c0fbaf534f0f0834bd087d8d4999b0fe769e3ff3806f6d60c6c377](https://preprod.cardanoscan.io/transaction/a192ac1f68c0fbaf534f0f0834bd087d8d4999b0fe769e3ff3806f6d60c6c377) | 494661 lovelace (0.494661 tADA) | the account's reserve | 0 | collateral only |
| 4 | [5f559c14d517d89c7989137fea96e127ccd61369cf31bb0f7003e52ae94de40a](https://preprod.cardanoscan.io/transaction/5f559c14d517d89c7989137fea96e127ccd61369cf31bb0f7003e52ae94de40a) | 564212 lovelace (0.564212 tADA) | the account's reserve | 0 | collateral only |
| 5 | [078533aa3a6503fdc2acaf0c722f1a5c6f8c7c475982d67c7fa5338ef83f57b5](https://preprod.cardanoscan.io/transaction/078533aa3a6503fdc2acaf0c722f1a5c6f8c7c475982d67c7fa5338ef83f57b5) | 511555 lovelace (0.511555 tADA) | the account's funds | 0 | collateral only |
| 6 | none, refused | | | 0 | none |
| 7 | [54b7d6fc231858f69446cfb278659f4305b3f89f4e0a886720b9c59d4cd7bd8a](https://preprod.cardanoscan.io/transaction/54b7d6fc231858f69446cfb278659f4305b3f89f4e0a886720b9c59d4cd7bd8a) | 468904 lovelace (0.468904 tADA) | the account's reserve | 0 | collateral only |
| 8 | [4bdc74f740122d1d1263b7206b5b7b37114bd5a7b79ccca0d857037fb3344573](https://preprod.cardanoscan.io/transaction/4bdc74f740122d1d1263b7206b5b7b37114bd5a7b79ccca0d857037fb3344573) | 541362 lovelace (0.541362 tADA) | the account's reserve | 0 | collateral only |
| 9 | none, refused | | | 0 | none |

## Audit trail of the collateral mode witnesses

The audit trail of a hosted service is read through the admin route, which is its operator's; this run did not read it.

