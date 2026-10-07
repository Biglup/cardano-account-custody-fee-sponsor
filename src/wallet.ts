import { randomBytes } from 'node:crypto';
import type { Provider, Wallet } from '@biglup/cometa';
import { Cometa } from './cometa.js';
import type { Config } from './config.js';

/** The derivation path of the funding wallet: account 0, payment 0, stake 0. */
const SPONSOR_CREDENTIALS = { account: 0, paymentIndex: 0, stakingIndex: 0 };

/** A password cometa uses to encrypt the derived keys in memory, fresh for every process. */
const walletPassword = randomBytes(32);

/** Hands cometa a copy of the password, since it wipes what it is given after use. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(walletPassword));

/**
 * The sponsor's own wallet: the cometa wallet used to build and sign, and
 * the identifiers derived from its address that the policy and the pool
 * need without re-deriving them on every request.
 */
export interface ServiceWallet {
  wallet: Wallet;
  address: string;
  paymentKeyHash: string;
  stakeKeyHash: string;
}

/**
 * Loads the sponsor wallet from `config.sponsorMnemonic` and the given
 * provider. The mnemonic is only ever read from the config object; once
 * the wallet is derived, this function empties that array in place so no
 * later code path can read or log it.
 */
export const loadServiceWallet = async (config: Config, provider: Provider): Promise<ServiceWallet> => {
  let wallet: Wallet;
  try {
    wallet = await Cometa.SingleAddressWallet.createFromMnemonics({
      mnemonics: config.sponsorMnemonic,
      provider,
      getPassword,
      credentialsConfig: SPONSOR_CREDENTIALS,
    });
  } finally {
    config.sponsorMnemonic.fill('');
    config.sponsorMnemonic.length = 0;
  }

  const address = await wallet.getChangeAddress();
  const base = address.asBase();
  if (!base) {
    throw new Error('The sponsor address is not a base address');
  }
  const paymentCredential = base.getPaymentCredential();
  const stakeCredential = base.getStakeCredential();
  if (paymentCredential.type !== Cometa.CredentialType.KeyHash || stakeCredential.type !== Cometa.CredentialType.KeyHash) {
    throw new Error('The sponsor address must use key hash credentials');
  }

  return {
    wallet,
    address: address.toString(),
    paymentKeyHash: paymentCredential.hash,
    stakeKeyHash: stakeCredential.hash,
  };
};
