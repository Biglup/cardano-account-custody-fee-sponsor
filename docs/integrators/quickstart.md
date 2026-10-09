# Quick start

This page creates a custody account for an owner who holds no ADA, with the
fee sponsor paying, and then spends from that account with the sponsor lending
collateral. It uses the [client adapter](client-adapter.md) and the
account custody contract's off-chain library, both from a checkout, against a
running service.

The two steps use the two [modes](../overview.md#the-two-modes):

1. A sponsored creation in [fee mode](../glossary.md#fee-mode).
2. An owner spend in [collateral mode](../glossary.md#collateral-mode), paid
   by the account.

## What you need

- Node 22.
- The base URL of a running fee sponsor service and a
  [client key](../glossary.md#client-key) its operator issued. A deployment
  serves preprod at `https://sponsor-preprod.lw.iog.io`.
- A Blockfrost project id for preprod.
- The owner's mnemonic. The owner may hold no ADA. Its key must not own an
  account yet, since an account's stake credential can be registered once.
- A funding wallet's mnemonic, holding some preprod ADA. It deposits into the
  account so that the account can pay for its own operations.
- An address to pay in the spend.

## Set up

Clone both repositories side by side, and build the contract's off-chain
library and the adapter:

```sh
git clone https://github.com/Biglup/cardano-account-custody-contract.git
git clone https://github.com/Biglup/cardano-account-custody-fee-sponsor.git
(cd cardano-account-custody-contract/offchain && npm ci && npm run build)
(cd cardano-account-custody-fee-sponsor && npm ci && npm run build)
```

The fee sponsor's install links the contract checkout next to it, so clone
the contract first.

The contract checkout must be the build the service serves. Its `plutus.json`
must equal this repository's `contract/plutus.json`:

```sh
cmp cardano-account-custody-contract/plutus.json \
  cardano-account-custody-fee-sponsor/contract/plutus.json
```

The library builds creations under the logic its blueprint pins. The service
must list that logic as [known logic](../glossary.md#known-logic), or it
refuses every transaction under `known_logic`.

Create the application next to the two checkouts:

```sh
mkdir sponsor-quickstart && cd sponsor-quickstart
npm init -y && npm pkg set type=module
npm install @biglup/cometa@^1.2.0 \
  ../cardano-account-custody-contract/offchain \
  ../cardano-account-custody-fee-sponsor
npm install --save-dev tsx
cp ../cardano-account-custody-fee-sponsor/scripts/shared-cometa.ts .
```

Both packages install as links, and each keeps its own copy of cometa.
`shared-cometa.ts`, imported first, points every copy at the one installed in
the application. [One copy of cometa](client-adapter.md#one-copy-of-cometa)
explains why this matters.

## The program

Save this as `quickstart.ts`:

```ts
import './shared-cometa.js';
import type { VkeyWitnessSet, Wallet } from '@biglup/cometa';
import { Cometa, createAccount, deposit, loadNetworkScripts, paymentKeyHashOf, spendWithDevice } from 'cardano-account-custody-offchain';
import { SponsorError, SponsorWallet } from 'cardano-account-custody-fee-sponsor';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

await Cometa.ready();

const provider = new Cometa.BlockfrostProvider({ network: Cometa.NetworkMagic.Preprod, projectId: env('BLOCKFROST_PROJECT_ID') });
const baseUrl = env('SPONSOR_URL');
const apiKey = env('SPONSOR_API_KEY');
const network = loadNetworkScripts('preprod');

const walletOf = (mnemonic: string): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics: mnemonic.trim().split(/\s+/),
    provider,
    getPassword: () => Promise.resolve(new TextEncoder().encode(env('WALLET_PASSWORD'))),
    credentialsConfig: { account: 0, paymentIndex: 0, stakingIndex: 0 },
  });

const ownerWallet = await walletOf(env('OWNER_MNEMONIC'));
const funder = await walletOf(env('FUNDER_MNEMONIC'));
const owner = paymentKeyHashOf((await ownerWallet.getChangeAddress()).toString());
if (owner === undefined) {
  throw new Error('The owner wallet has no key address');
}

const signAndSubmit = async (tx: string, signers: Wallet[]): Promise<string> => {
  const witnesses: VkeyWitnessSet = [];
  for (const signer of signers) {
    witnesses.push(...(await signer.signTransaction(tx, true)));
  }
  const txId = await provider.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
  if (!(await provider.confirmTransaction(txId, 180_000))) {
    throw new Error(`Transaction ${txId} did not confirm`);
  }
  return txId;
};

try {
  const sponsor = new SponsorWallet({ baseUrl, apiKey, provider });
  try {
    const creation = await createAccount({
      owner,
      wallet: ownerWallet,
      sponsor,
      provider,
      network,
      state: { devices: [owner], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n },
    });
    console.log('Account created:', await signAndSubmit(creation, [sponsor, ownerWallet]));
  } finally {
    await sponsor.release();
  }

  const funding = await deposit({ owner, wallet: funder, value: { coins: 20_000_000n } });
  console.log('Deposit:', await signAndSubmit(funding, [funder]));

  const collateral = new SponsorWallet({ baseUrl, apiKey, provider, mode: 'collateral' });
  const spend = await spendWithDevice({
    owner,
    wallet: ownerWallet,
    collateral,
    provider,
    network,
    outputs: [{ address: env('RECIPIENT_ADDRESS'), value: { coins: 5_000_000n } }],
  });
  console.log('Owner spend:', await signAndSubmit(spend, [collateral, ownerWallet]));
} catch (error) {
  if (error instanceof SponsorError) {
    console.error(`The sponsor answered ${error.status} ${error.code}${error.rule === undefined ? '' : ` under ${error.rule}`}: ${error.detail}`);
  }
  throw error;
}
```

Run it:

```sh
BLOCKFROST_PROJECT_ID=<preprod project id> \
SPONSOR_URL=https://sponsor-preprod.lw.iog.io \
SPONSOR_API_KEY=<client key> \
OWNER_MNEMONIC="<owner words>" \
FUNDER_MNEMONIC="<funding wallet words>" \
WALLET_PASSWORD=<any password> \
RECIPIENT_ADDRESS=<addr_test1...> \
npx tsx quickstart.ts
```

## What happens

### The sponsored creation

1. `createAccount` asks the adapter for a transaction builder. The adapter
   takes a [lease](../glossary.md#lease) with `POST /v1/leases`.
2. The builder spends the leased fee UTxO, declares the
   [shared collateral](../glossary.md#shared-collateral) and sends the change
   back to the sponsor. Its validity upper bound is the lease expiry.
3. `createAccount` registers the account's stake credential, mints the state
   NFT and writes the control output. It requires the owner's signature.
4. `sponsor.signTransaction` posts the transaction to
   `POST /v1/leases/:id/witness`. The service checks it against the
   [policy](../policy.md) and returns the sponsor's witness. The witness
   consumes the lease.
5. The owner wallet adds its signature, and the program submits through its
   own provider.

The sponsor pays the fee, the stake registration deposit and the control
output's lovelace. The owner pays nothing.

`sponsor.release()` in the `finally` block gives back a lease that was taken
but not consumed, as when building fails. After a successful witness the
adapter holds no lease and the call does nothing.

### The deposit

After creation the account pays its own way. The funding wallet sends ADA to
the account address with the contract's `deposit`. Anyone can deposit, and no
sponsor is involved.

### The collateral mode spend

1. `spendWithDevice` asks the adapter for a builder. The adapter reads the
   shared collateral with `GET /v1/collateral`. No lease is taken.
2. The builder spends the account's own UTxOs, pays the output and the fee
   from them, and declares the shared collateral. The change returns to the
   account.
3. `collateral.signTransaction` posts the transaction to
   `POST /v1/collateral/witness`. The service checks that it takes no sponsor
   value and returns the sponsor's witness.
4. The owner wallet signs, and the program submits.

The sponsor lends collateral and pays nothing.

## Next

- [flows.md](flows.md) shows both modes as sequences, and the life of a lease.
- [client-adapter.md](client-adapter.md) documents the adapter in full.
- [errors.md](errors.md) says what each refusal means and how to fix it.
- [retries-and-idempotency.md](retries-and-idempotency.md) says when to
  present a transaction again.
- [api.md](api.md) documents every route for clients that do not use the
  adapter.
