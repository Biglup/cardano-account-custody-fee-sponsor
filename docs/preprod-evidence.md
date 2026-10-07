# Preprod evidence

A custody account created on preprod on 2026-10-07T12:11:06.193Z with the fee sponsor service paying the fee, the registration
deposit and the control UTxO, and providing the collateral, for an owner wallet that holds no ADA. The service ran
against preprod with its funding wallet, a client key was issued through the admin route, and the client created the
account through the contract's own builder with the sponsor wallet adapter as the sponsor.

## Setup

- Sponsor address: `addr_test1qqalup9s2kpfrcf60zqxusar6fhgkcsd6z94a65ucmdaavxy456rp43g7mn75fnrw8tajhvtdc920z5d8z0npnjm52asxk8ews`
- Account script hash: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3`
- Pool before the run: 5 free fee UTxOs, 3 free collateral UTxOs
- No replenishment was needed
- Pool after the run: 4 free fee UTxOs, 3 free collateral UTxOs

## Sponsored account creation

- Owner wallet: account index 11 of the sponsor mnemonic, address `addr_test1qz4apvttzhehq4fa87e9azk8hgc5g5t5j0u5kxznzh7ftsgldrtwgr3k569rhrd3zr6ylp0d6eahf40pcxgt5vnepx6s3xa3vv`, holding no ADA
- Owner key hash: `abd0b16b15f370553d3fb25e8ac7ba3144517493f94b185315fc95c1`
- Account address: `addr_test1xqzjfatm0pw08fzm0mtq9xec0hpel7eyzx73edpsp3vv9suyd0jd3jx7kq2rpmylvhc99fpyhgqupygj6hsevqm5l53qk4sl8h`
- Stake credential: `846be4d8c8deb01430ec9f65f052a424ba01c09112d5e1960374fd22`, reward address `stake_test17zzxhexcer0tq9psaj0ktuzj5sjt5qwqjyfdtcvkqd606gs6m5ggw`
- State NFT: `0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3846be4d8c8deb01430ec9f65f052a424ba01c09112d5e1960374fd22`
- Lease `b3c424a9-467d-4e5c-ac9e-a61daf4746d2`, expiring 2026-10-07T12:20:13.137Z: fee UTxO `86889da713d027720c242385e8274a8eeb51182dac4d260d1871a7b89ec66ab2#1` of 100000000 lovelace (100.000000 tADA),
  collateral UTxO `187432c27e3c6f3f834c522b71aa57c71ecc6017e4e3007986e342ef4faef2d0#1` of 5000000 lovelace (5.000000 tADA)
- Validity upper bound: slot 135692413, the lease expiry, as the adapter presets it
- Transaction: [dc7017b40798f7638143aaddd75256fb9ca6c4c53c94e2efa7039bccfcd769d0](https://preprod.cardanoscan.io/transaction/dc7017b40798f7638143aaddd75256fb9ca6c4c53c94e2efa7039bccfcd769d0)

| Amount | Lovelace |
| ------ | -------- |
| Fee | 514324 lovelace (0.514324 tADA) |
| Stake registration deposit | 2000000 lovelace (2.000000 tADA) |
| Control UTxO | 2000000 lovelace (2.000000 tADA) |
| Sponsor change | 95485676 lovelace (95.485676 tADA) |
| Sponsored in total | 4514324 lovelace (4.514324 tADA) |

The fee UTxO held 100000000 lovelace (100.000000 tADA); the change back to the sponsor leaves exactly the fee, the deposit and the
control UTxO sponsored, which is what the sponsor outflow rule requires of a creation.

On chain after confirmation:

- The control UTxO `dc7017b40798f7638143aaddd75256fb9ca6c4c53c94e2efa7039bccfcd769d0#0` sits at the account address holding 2000000 lovelace (2.000000 tADA) and the state NFT
- The stake credential is registered: Blockfrost lists the reward address as registered, active from the next epoch
- The sponsor change UTxO `dc7017b40798f7638143aaddd75256fb9ca6c4c53c94e2efa7039bccfcd769d0#1` holds 95485676 lovelace (95.485676 tADA)
- The audit trail records the witness as issued: `{"leaseId":"b3c424a9-467d-4e5c-ac9e-a61daf4746d2","txHash":"dc7017b40798f7638143aaddd75256fb9ca6c4c53c94e2efa7039bccfcd769d0","kind":"creation","sponsoredLovelace":4514324,"fee":"514324"}`

## Refused transactions

A second creation, for the owner at account index 12 (`addr_test1qpp4faeqyz9ta8q9f5ggt2d0hlmgcz9vmnv4ee4p4swcluu6t7t8ypeq6myvt00cje22ccgkhdwecmy334x3mmzkzhpsp64hx9`), built with a sponsor wallet
that slips a 5000000 lovelace (5.000000 tADA) payment to the first owner's address into every builder, so that the creation
also pays sponsor value to a third party. Its hash is
`5c6df56968066879ae5fdef0e64a3c52f1cd4774963851c2fdb1e3e350d62c45`; it was never submitted.

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
     "detail": "Lease b3c424a9-467d-4e5c-ac9e-a61daf4746d2 already issued a witness"
   }
   ```

