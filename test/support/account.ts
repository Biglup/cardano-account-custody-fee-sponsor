import { readFileSync } from 'node:fs';
import type { PlutusData, PlutusScript, RewardAddress, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';

/** The parts of the contract's Aiken blueprint the fixtures read. */
interface Blueprint {
  validators: { title: string; compiledCode: string }[];
}

/** The key of the account's only device, which signs every owner operation. */
export const DEVICE_KEY = 'aa'.repeat(28);

/** A key outside the account and the sponsor, usable as a destination or a foreign signer. */
export const STRANGER_KEY = 'ff'.repeat(28);

/** The lovelace a control UTxO carries in the fixtures. */
export const CONTROL_LOVELACE = 2_000_000n;

/** The blueprint of the account custody contract, as `aiken build` writes it. */
const blueprint = JSON.parse(readFileSync(new URL('./plutus.json', import.meta.url), 'utf8')) as Blueprint;

/** The compiled code of the first validator entry whose title starts with `prefix`; every handler of a validator shares it. */
const compiledCode = (prefix: string): string => {
  const validator = blueprint.validators.find((entry) => entry.title.startsWith(`${prefix}.`));
  if (!validator) {
    throw new Error(`The blueprint has no validator titled ${prefix}`);
  }
  return validator.compiledCode;
};

const plutusScript = (bytes: string): PlutusScript => ({ type: Cometa.ScriptType.Plutus, bytes, version: Cometa.PlutusLanguageVersion.V3 });

/** The account validator, whose hash is the payment credential of every account and the policy of every state NFT. */
export const accountScript = plutusScript(compiledCode('account.account'));
export const accountScriptHash = Cometa.computeScriptHash(accountScript);

/**
 * The account's stake script. The contract applies the stake validator
 * to the owner key and the account script hash; the fixtures use the
 * validator as the blueprint ships it, since the policy only ever
 * compares script hashes and never runs the script.
 */
export const stakeScript = plutusScript(compiledCode('account_stake.account_stake'));
export const stakeScriptHash = Cometa.computeScriptHash(stakeScript);

/** The address of the account under test: the account script paying, the stake script staking. */
export const accountAddress = Cometa.BaseAddress.fromCredentials(
  Cometa.NetworkId.Testnet,
  { hash: accountScriptHash, type: Cometa.CredentialType.ScriptHash },
  { hash: stakeScriptHash, type: Cometa.CredentialType.ScriptHash },
)
  .toAddress()
  .toString();

/** The reward account of the account's stake script. */
export const accountRewardAddress: RewardAddress = Cometa.RewardAddress.fromCredentials(Cometa.NetworkId.Testnet, {
  hash: stakeScriptHash,
  type: Cometa.CredentialType.ScriptHash,
});

/** The asset id of the account's state NFT: the account policy and the stake script hash as the name. */
export const stateNftAssetId = `${accountScriptHash}${stakeScriptHash}`;

/** A constructor with the given index and fields. */
const constr = (index: number, fields: PlutusData[] = []): PlutusData => ({ constructor: BigInt(index), fields: { items: fields } });

/** The account state of a freshly created account owned by `device`: that one device, no grants, generation zero. */
export const initialStateOf = (device: string): PlutusData => constr(0, [{ items: [Cometa.hexToUint8Array(device)] }, { items: [] }, 0n]);

/** The account state of a freshly created account: the fixture device, no grants, generation zero. */
export const initialState: PlutusData = initialStateOf(DEVICE_KEY);

/** The redeemer of the owner path, the mint handler and the stake script, none of which carries data. */
export const unitRedeemer: PlutusData = constr(0);

/** The control UTxO of the account at a fictitious earlier transaction, carrying the state NFT and the initial state inline. */
export const controlUtxo = (txId: string, lovelace = CONTROL_LOVELACE): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: lovelace, assets: { [stateNftAssetId]: 1n } }, datum: initialState },
});

/** A fund UTxO at the account address: lovelace only, no datum. */
export const fundUtxo = (txId: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: lovelace } },
});

/** A key address outside the account and the sponsor. */
export const enterpriseAddress = (keyHash: string): string =>
  Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: keyHash, type: Cometa.CredentialType.KeyHash })
    .toAddress()
    .toString();

/** The destination outside the account and the sponsor the tests pay to. */
export const strangerAddress = enterpriseAddress(STRANGER_KEY);

/** A pointer address paying to the key, with its stake delegated by pointer, as an early Shelley wallet could still hold funds at. */
export const pointerAddress = (keyHash: string): string =>
  Cometa.PointerAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: keyHash, type: Cometa.CredentialType.KeyHash }, { slot: 1n, txIndex: 2, certIndex: 3 })
    .toAddress()
    .toString();

/** A Byron era address, whose spending key no Shelley credential names. */
export const byronAddress = Cometa.ByronAddress.fromCredentials(STRANGER_KEY, { derivationPath: '', magic: -1 }, Cometa.ByronAddressType.PubKey)
  .toAddress()
  .toString();

/** A script that is neither the account script nor its stake script: the always succeeding Plutus script. */
export const foreignScript: PlutusScript = plutusScript('4e4d01000033222220051200120011');
export const foreignScriptHash = Cometa.computeScriptHash(foreignScript);

/** The address paying to the foreign script. */
export const foreignScriptAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, {
  hash: foreignScriptHash,
  type: Cometa.CredentialType.ScriptHash,
})
  .toAddress()
  .toString();

/** A UTxO at an address paying to a script, which only a transaction running that script can spend. */
export const scriptUtxo = (txId: string, address: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address, value: { coins: lovelace } },
});
