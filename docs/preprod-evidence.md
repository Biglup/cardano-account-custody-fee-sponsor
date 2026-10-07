# Preprod evidence

A custody account taken through its life on preprod on 2026-10-07T13:36:25.530Z with the fee sponsor service as the only source of
sponsor funds and collateral. The service ran against preprod with its funding wallet, a client key was issued through
the admin route, and every transaction was built through the contract's own builders with the sponsor wallet adapter:
in fee mode as the `sponsor` of the creation, where the service paid the fee, the registration deposit and the control
UTxO for an owner wallet that holds no ADA, and in collateral mode as the `collateral` wallet of every later operation,
where the account paid its own fee and the service contributed the shared collateral and nothing else. The owner and the
agent wallets held no ADA at any point.

## Setup

- Sponsor address: `addr_test1qqalup9s2kpfrcf60zqxusar6fhgkcsd6z94a65ucmdaavxy456rp43g7mn75fnrw8tajhvtdc920z5d8z0npnjm52asxk8ews`
- Account script hash: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3`
- Pool before the run: 5 free fee UTxOs, one shared collateral UTxO and 2 spare
- No replenishment was needed
- Pool after the run: 5 free fee UTxOs, one shared collateral UTxO and 2 spare
- Owner wallet: account index 12 of the sponsor mnemonic, address `addr_test1qpp4faeqyz9ta8q9f5ggt2d0hlmgcz9vmnv4ee4p4swcluu6t7t8ypeq6myvt00cje22ccgkhdwecmy334x3mmzkzhpsp64hx9`, holding no ADA
- Owner key hash: `4354f720208abe9c054d1085a9afbff68c08acdcd95ce6a1ac1d8ff3`
- Agent wallet: account index 13 of the sponsor mnemonic, address `addr_test1qpt6d5lwdn8m65sleavwzx3kay8khtwnu7tvrd36frsc7wjdq3sr0z5fc2chq5q6tdpezze9rapwwrz64v8ppecrufdsldvxja`, holding no ADA
- Agent key hash: `57a6d3ee6ccfbd521fcf58e11a36e90f6badd3e796c1b63a48e18f3a`
- Recipient address: account index 14 of the sponsor mnemonic, `addr_test1qpdnsw3weduzpah3g5j3cg2g20pwhlq77ftxpsdt0jec9gkk4jm2qd9nrxrq5azemc6fz48cplst4gmz0df0s3shp78shxtuk8`, the third party the account pays
- Account address: `addr_test1xqzjfatm0pw08fzm0mtq9xec0hpel7eyzx73edpsp3vv9saljpqrznwdgndknv45g896pdt8zx4vqfsjsnwq727tnzyspjck6g`
- Stake credential: `bf9040314dcd44db69b2b441cba0b56711aac0261284dc0f2bcb9889`, reward address `stake_test17zleqsp3fhx5fkmfk26yrjaqk4n3r2kqycfgfhq0909e3zgax00dp`
- State NFT: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3bf9040314dcd44db69b2b441cba0b56711aac0261284dc0f2bcb9889`

## 1. Sponsored account creation, fee mode

- Lease `b26ee940-dd6d-4456-b6c4-8336af3364ff`, expiring 2026-10-07T13:40:45.753Z: fee UTxO `4c08437ecbd8cbae9356ca8a889895129816c4035ba8e134243818ac003b31f2#1` of 95485676 lovelace (95.485676 tADA),
  shared collateral UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA)
- Validity upper bound: slot 135697245, the lease expiry, as the adapter presets it
- Transaction: [a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7](https://preprod.cardanoscan.io/transaction/a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7), signed by the owner device and the service

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 514324 lovelace (0.514324 tADA) | the sponsor |
| Stake registration deposit | 2000000 lovelace (2.000000 tADA) | the sponsor |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the sponsor |
| Sponsor change | 90971352 lovelace (90.971352 tADA) | |
| Sponsored in total | 4514324 lovelace (4.514324 tADA) | the sponsor |

The fee UTxO held 95485676 lovelace (95.485676 tADA); the change back to the sponsor leaves exactly the fee, the deposit and the
control UTxO sponsored, which is what the sponsor outflow rule requires of a creation.

On chain after confirmation:

- The control UTxO `a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7#0` sits at the account address holding 2000000 lovelace (2.000000 tADA) and the state NFT
- The stake credential is registered: Blockfrost lists the reward address as registered, active from the next epoch
- The sponsor change UTxO `a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7#1` holds 90971352 lovelace (90.971352 tADA)
- The audit trail records the witness as issued: `{"leaseId":"b26ee940-dd6d-4456-b6c4-8336af3364ff","txHash":"a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7","kind":"creation","sponsoredLovelace":4514324,"fee":"514324"}`

## 2. Deposit

- Transaction: [4c6a391ee7805c1520f3a2d289a90fcce8acbd2e3f565498e218b41202fe53eb](https://preprod.cardanoscan.io/transaction/4c6a391ee7805c1520f3a2d289a90fcce8acbd2e3f565498e218b41202fe53eb), a plain transfer of 50000000 lovelace (50.000000 tADA) to the account address
- Paid by the funding wallet, which is the sponsor wallet spending from its reserve outside the service, with a fee of 168449 lovelace (0.168449 tADA);
  the service was not involved and no pool UTxO was touched

## 3. Owner spend, collateral mode

5000000 lovelace (5.000000 tADA) paid from the account to the recipient address through `spendWithDevice`, with the adapter in collateral mode as
the builder's `collateral` wallet.

- Transaction: [d886a6e8b740658404a9dcefe39ce151d257ea7e4c7215e71f2f19cc3f7e4d03](https://preprod.cardanoscan.io/transaction/d886a6e8b740658404a9dcefe39ce151d257ea7e4c7215e71f2f19cc3f7e4d03), signed by the owner device and the service
- Validity upper bound: slot 135697280, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA), total collateral 696678 lovelace (0.696678 tADA),
  collateral return of 4303322 lovelace (4.303322 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 464452 lovelace (0.464452 tADA) | the account |
| Paid away from the account | 5000000 lovelace (5.000000 tADA) | the account |
| Control UTxO | 2000000 lovelace (2.000000 tADA) | the account, including any growth |
| Change back to the account | 44535548 lovelace (44.535548 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 4. Grant issued, collateral mode

A lovelace grant in slot 0 to the agent key through `issueGrant`: 10000000 lovelace (10.000000 tADA) per call, 10000000 lovelace (10.000000 tADA) in total,
expiring at 2026-10-07T15:33:08.921Z, the recipient address as the only recipient. The larger state raises the
control UTxO's lovelace, which the account pays, as it pays the fee.

- Transaction: [8bb9572c87f8e4cc750523c083b758706fdc1f4404af72aa8d397f6c41070dae](https://preprod.cardanoscan.io/transaction/8bb9572c87f8e4cc750523c083b758706fdc1f4404af72aa8d397f6c41070dae), signed by the owner device and the service
- Validity upper bound: slot 135697331, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA), total collateral 708023 lovelace (0.708023 tADA),
  collateral return of 4291977 lovelace (4.291977 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 472015 lovelace (0.472015 tADA) | the account |
| Paid away from the account | 0 lovelace (0.000000 tADA) | the account |
| Control UTxO | 2090350 lovelace (2.090350 tADA) | the account, including any growth |
| Change back to the account | 43973183 lovelace (43.973183 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 5. Agent spend within the cap, collateral mode

3000000 lovelace (3.000000 tADA) paid from the account to the recipient address through `spendWithGrant`, built from the persisted account
record with the agent wallet signing and the adapter in collateral mode as the builder's `collateral` wallet. The fee comes
out of the account and counts against the grant alongside the payout.

- Transaction: [4a7ae75e801c9c1ae00b4d3ba574c5dd56585ef178298632ed82f521ff921ec4](https://preprod.cardanoscan.io/transaction/4a7ae75e801c9c1ae00b4d3ba574c5dd56585ef178298632ed82f521ff921ec4), signed by the agent key and the service
- Validity upper bound: slot 135697139, set by the builder's validUntilSlot, 300 slots ahead
- Collateral: the shared UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA), total collateral 1271459 lovelace (1.271459 tADA),
  collateral return of 3728541 lovelace (3.728541 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 847639 lovelace (0.847639 tADA) | the account |
| Paid away from the account | 3000000 lovelace (3.000000 tADA) | the account |
| Control UTxO | 2090350 lovelace (2.090350 tADA) | the account, including any growth |
| Change back to the account | 40125544 lovelace (40.125544 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

- Remaining cap after the spend: 6152361 lovelace (6.152361 tADA)

## 6. Agent spend over the cap, refused

8000000 lovelace (8.000000 tADA) to the recipient address through `spendWithGrant` built without the builder's checks, so that the validator is
the one to refuse it. The service evaluated the transaction through the provider before signing, the evaluation failed in
phase two, and the service refused it under `evaluates` without signing. Its hash is `bd01f51fcde5b63dc76f8cdd3fadb98590fb29fe2d2a89087ae521ad2cb51739`; it was never submitted.

1. The agent spend over the cap, presented to the collateral witness route: HTTP 422

   ```json
   {
     "error": "invalid_transaction",
     "rule": "evaluates",
     "detail": "The transaction does not evaluate: evaluateTransaction: Blockfrost endpoint returned evaluation failure: {\"EvaluationFailure\":{\"ScriptFailures\":{}}}"
   }
   ```

## 7. Grant revoked, collateral mode

The grant in slot 0 revoked through `revokeGrant`, leaving the account with 0 grants.

- Transaction: [775dcce4e8d8406aae1b20c1dec4949f4af9a2a55963d2332f78ba3ad459504b](https://preprod.cardanoscan.io/transaction/775dcce4e8d8406aae1b20c1dec4949f4af9a2a55963d2332f78ba3ad459504b), signed by the owner device and the service
- Validity upper bound: slot 135697451, within the collateral validity window, as the adapter presets it
- Collateral: the shared UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA), total collateral 692355 lovelace (0.692355 tADA),
  collateral return of 4307645 lovelace (4.307645 tADA) to the sponsor; nothing of it was taken, since the transaction passed phase two

| Amount | Lovelace | Paid by |
| ------ | -------- | ------- |
| Fee | 461570 lovelace (0.461570 tADA) | the account |
| Paid away from the account | 0 lovelace (0.000000 tADA) | the account |
| Control UTxO | 2090350 lovelace (2.090350 tADA) | the account, including any growth |
| Change back to the account | 39663974 lovelace (39.663974 tADA) | |
| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |

## 8. Refused creations, fee mode

A second creation, for the owner at account index 14 (`addr_test1qpdnsw3weduzpah3g5j3cg2g20pwhlq77ftxpsdt0jec9gkk4jm2qd9nrxrq5azemc6fz48cplst4gmz0df0s3shp78shxtuk8`), built with a sponsor wallet
that slips a 5000000 lovelace (5.000000 tADA) payment to the first owner's address into every builder, so that the creation
also pays sponsor value to a third party. Its hash is
`54a377bd04270a68397f7c3c6e3e25202608a1415f744dbc061e5e2d9a186679`; it was never submitted.

1. The creation paying sponsor value to a third party, on a fresh lease: HTTP 422

   ```json
   {
     "error": "invalid_transaction",
     "rule": "sponsor_outflow_bounded",
     "detail": "The sponsor input is drawn down by 9519336 lovelace but the fee, the registration deposit and the control output account for 4519336"
   }
   ```

2. The same transaction presented on the lease the creation consumed: HTTP 409

   ```json
   {
     "error": "lease_consumed",
     "detail": "Lease b26ee940-dd6d-4456-b6c4-8336af3364ff already issued a witness"
   }
   ```

## Who paid what

| Step | Transaction | Fee | Fee paid by | Sponsor lovelace spent | Sponsor part |
| ---- | ----------- | --- | ----------- | ---------------------- | ------------ |
| 1 | [a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7](https://preprod.cardanoscan.io/transaction/a9b4b85d67cdf2079f399625447b17aa0fc1d1b82c6f0e1bf6f86895407071a7) | 514324 lovelace (0.514324 tADA) | the sponsor | 4514324 lovelace (4.514324 tADA) | fee, deposit, control UTxO and collateral |
| 2 | [4c6a391ee7805c1520f3a2d289a90fcce8acbd2e3f565498e218b41202fe53eb](https://preprod.cardanoscan.io/transaction/4c6a391ee7805c1520f3a2d289a90fcce8acbd2e3f565498e218b41202fe53eb) | 168449 lovelace (0.168449 tADA) | the funding wallet | none through the service | none |
| 3 | [d886a6e8b740658404a9dcefe39ce151d257ea7e4c7215e71f2f19cc3f7e4d03](https://preprod.cardanoscan.io/transaction/d886a6e8b740658404a9dcefe39ce151d257ea7e4c7215e71f2f19cc3f7e4d03) | 464452 lovelace (0.464452 tADA) | the account | 0 | collateral only |
| 4 | [8bb9572c87f8e4cc750523c083b758706fdc1f4404af72aa8d397f6c41070dae](https://preprod.cardanoscan.io/transaction/8bb9572c87f8e4cc750523c083b758706fdc1f4404af72aa8d397f6c41070dae) | 472015 lovelace (0.472015 tADA) | the account | 0 | collateral only |
| 5 | [4a7ae75e801c9c1ae00b4d3ba574c5dd56585ef178298632ed82f521ff921ec4](https://preprod.cardanoscan.io/transaction/4a7ae75e801c9c1ae00b4d3ba574c5dd56585ef178298632ed82f521ff921ec4) | 847639 lovelace (0.847639 tADA) | the account | 0 | collateral only |
| 6 | none, refused | | | 0 | none |
| 7 | [775dcce4e8d8406aae1b20c1dec4949f4af9a2a55963d2332f78ba3ad459504b](https://preprod.cardanoscan.io/transaction/775dcce4e8d8406aae1b20c1dec4949f4af9a2a55963d2332f78ba3ad459504b) | 461570 lovelace (0.461570 tADA) | the account | 0 | collateral only |
| 8 | none, refused | | | 0 | none |

## Audit trail of the collateral mode witnesses

- `{"mode":"collateral","txHash":"d886a6e8b740658404a9dcefe39ce151d257ea7e4c7215e71f2f19cc3f7e4d03","kind":"operation","sponsoredLovelace":0,"fee":"464452"}`
- `{"mode":"collateral","txHash":"8bb9572c87f8e4cc750523c083b758706fdc1f4404af72aa8d397f6c41070dae","kind":"operation","sponsoredLovelace":0,"fee":"472015"}`
- `{"mode":"collateral","txHash":"4a7ae75e801c9c1ae00b4d3ba574c5dd56585ef178298632ed82f521ff921ec4","kind":"operation","sponsoredLovelace":0,"fee":"847639"}`
- `{"mode":"collateral","txHash":"775dcce4e8d8406aae1b20c1dec4949f4af9a2a55963d2332f78ba3ad459504b","kind":"operation","sponsoredLovelace":0,"fee":"461570"}`

