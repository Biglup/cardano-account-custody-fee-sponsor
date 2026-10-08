import { readFileSync } from 'node:fs';
import type { Credential, PlutusData, PlutusScript, RewardAddress, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';

/** The parts of the contract's Aiken blueprint the fixtures read. */
interface Blueprint {
  validators: { title: string; compiledCode: string }[];
}

/** The scope of a grant as the fixtures write it: a lovelace grant with its caps, its expiry and its recipients. */
export interface GrantScope {
  perCallCap: bigint;
  cap: bigint;
  expiresAt: bigint;
  recipients: string[];
}

/** A grant as the fixtures write it into a grant UTxO's datum. */
export interface Grant {
  slot: bigint;
  grantee: string;
  generation: bigint;
  scope: GrantScope;
}

/** The key of the account's only device, which signs every owner operation. */
export const DEVICE_KEY = 'aa'.repeat(28);

/** The key of the agent the fixture grant is issued to, which signs every agent spend. */
export const AGENT_KEY = 'bb'.repeat(28);

/** A key outside the account and the sponsor, usable as a destination or a foreign signer. */
export const STRANGER_KEY = 'ff'.repeat(28);

/** The lovelace a control UTxO carries in the fixtures. */
export const CONTROL_LOVELACE = 2_000_000n;

/** The lovelace a grant UTxO carries in the fixtures. */
export const GRANT_LOVELACE = 2_000_000n;

/** The slot of the fixture grant, the first an account issues. */
export const GRANT_SLOT = 0n;

/** The lovelace the fixture grant allows per call and in total. */
export const GRANT_CAP = 10_000_000n;

/** The lovelace an agent spend reduces the grant's remaining cap by on top of its outputs, ahead of the fee it will pay. */
export const GRANT_FEE_BOUND = 1_500_000n;

/** When the fixture grant expires: far enough out for every validity bound the tests set. */
export const GRANT_EXPIRES_AT = 1_800_000_000_000n;

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

/** The account validator, whose hash is the payment credential of every account and the policy of every account token. */
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

/** The stake script hash of another account, whose script the policy never runs either. */
export const otherStakeScriptHash = '11'.repeat(28);

/** A script credential. */
export const scriptCredential = (hash: string): { hash: string; type: typeof Cometa.CredentialType.ScriptHash } => ({ hash, type: Cometa.CredentialType.ScriptHash });

/** The address of an account: the account script paying, the account's stake script staking. */
export const accountAddressOf = (stakeHash: string): string =>
  Cometa.BaseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(accountScriptHash), scriptCredential(stakeHash)).toAddress().toString();

/** The address of the account under test. */
export const accountAddress = accountAddressOf(stakeScriptHash);

/** The address of the other account. */
export const otherAccountAddress = accountAddressOf(otherStakeScriptHash);

/** The reward account of the account's stake script. */
export const accountRewardAddress: RewardAddress = Cometa.RewardAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(stakeScriptHash));

/** The asset id of an account's state NFT: the account policy and the stake script hash as the name. */
export const stateNftAssetIdOf = (stakeHash: string): string => `${accountScriptHash}${stakeHash}`;

/** The asset id of the account's state NFT. */
export const stateNftAssetId = stateNftAssetIdOf(stakeScriptHash);

/** The asset id of the other account's state NFT. */
export const otherStateNftAssetId = stateNftAssetIdOf(otherStakeScriptHash);

/** The name of the grant token of an account's slot: the stake script hash followed by the slot as four big endian bytes. */
export const grantTokenName = (stakeHash: string, slot: bigint): string => `${stakeHash}${slot.toString(16).padStart(8, '0')}`;

/** The asset id of the grant token of the account's slot under the account policy. */
export const grantAssetIdOf = (slot: bigint): string => `${accountScriptHash}${grantTokenName(stakeScriptHash, slot)}`;

/** The asset id of the fixture grant's token. */
export const grantAssetId = grantAssetIdOf(GRANT_SLOT);

/** A constructor with the given index and fields. */
const constr = (index: number, fields: PlutusData[] = []): PlutusData => ({ constructor: BigInt(index), fields: { items: fields } });

/** The devices, generation, next slot, revoked slots and outstanding count of an account state, as the fixtures write it. */
export interface AccountState {
  devices: string[];
  grantGeneration: bigint;
  nextSlot: bigint;
  revoked: bigint[];
  outstanding: bigint;
}

/** An account state as the inline datum of a control UTxO, with its fields in declaration order. */
export const encodeState = (state: AccountState): PlutusData =>
  constr(0, [
    { items: state.devices.map((device) => Cometa.hexToUint8Array(device)) },
    state.grantGeneration,
    state.nextSlot,
    { items: [...state.revoked] },
    state.outstanding,
  ]);

/** The state of a freshly created account owned by `device`: that one device, zero counters, no revoked slot. */
export const initialStateOf = (device: string): PlutusData => encodeState({ devices: [device], grantGeneration: 0n, nextSlot: 0n, revoked: [], outstanding: 0n });

/** The state of a freshly created account: the fixture device, zero counters, no revoked slot. */
export const initialState: PlutusData = initialStateOf(DEVICE_KEY);

/** The state of the account once it has issued the fixture grant: the next slot and the outstanding count at one. */
export const grantedState: PlutusData = encodeState({ devices: [DEVICE_KEY], grantGeneration: 0n, nextSlot: 1n, revoked: [], outstanding: 1n });

/** The asset class of lovelace: the empty policy id and the empty asset name. */
const lovelaceAsset = constr(0, [new Uint8Array(0), new Uint8Array(0)]);

/** A grant as the inline datum of a grant UTxO: the slot, the grantee, the generation and the scope, a lovelace scope with zero lovelace caps. */
export const encodeGrant = (grant: Grant): PlutusData =>
  constr(0, [
    grant.slot,
    Cometa.hexToUint8Array(grant.grantee),
    grant.generation,
    constr(0, [lovelaceAsset, grant.scope.perCallCap, grant.scope.cap, 0n, 0n, grant.scope.expiresAt, { items: grant.scope.recipients.map(encodeAddress) }]),
  ]);

/** An address as the Plutus V3 script context presents it: a key or script credential, with an optional inline stake credential. */
const encodeAddress = (address: string): PlutusData => {
  const parsed = Cometa.Address.fromString(address);
  const base = parsed.asBase();
  const enterprise = parsed.asEnterprise();
  const credential = (named: Credential): PlutusData => constr(named.type === Cometa.CredentialType.KeyHash ? 0 : 1, [Cometa.hexToUint8Array(named.hash)]);
  if (base) {
    return constr(0, [credential(base.getPaymentCredential()), constr(0, [constr(0, [credential(base.getStakeCredential())])])]);
  }
  if (enterprise) {
    return constr(0, [credential(enterprise.getCredential()), constr(1)]);
  }
  throw new Error('Only base and enterprise addresses can be written into a grant');
};

/** The fixture grant: slot zero to the agent key under generation zero, the cap per call and in total, no recipient restriction. */
export const fixtureGrant: Grant = { slot: GRANT_SLOT, grantee: AGENT_KEY, generation: 0n, scope: { perCallCap: GRANT_CAP, cap: GRANT_CAP, expiresAt: GRANT_EXPIRES_AT, recipients: [] } };

/** The grant after a spend that pays `lovelace` away: the remaining cap reduced by the payout and the fee bound, as the contract's builder writes it. */
export const grantAfterSpend = (grant: Grant, lovelace: bigint): Grant => ({ ...grant, scope: { ...grant.scope, cap: grant.scope.cap - lovelace - GRANT_FEE_BOUND } });

/** The spend redeemers of the account validator, in constructor order; none carries data. */
export const deviceRedeemer: PlutusData = constr(0);
export const spendWithGrantRedeemer: PlutusData = constr(1);
export const sweepGrantRedeemer: PlutusData = constr(2);
export const fundRedeemer: PlutusData = constr(3);

/** The mint redeemers of the account validator, in constructor order; none carries data. */
export const createAccountRedeemer: PlutusData = constr(0);
export const issueGrantsRedeemer: PlutusData = constr(1);
export const burnGrantsRedeemer: PlutusData = constr(2);

/** The redeemer of every stake script run, which carries no data. */
export const operateRedeemer: PlutusData = constr(0);

/** The datum a reserve carries: constructor zero with no fields, which the validator never reads. */
export const reserveDatum: PlutusData = constr(0);

/** The control UTxO of the account at a fictitious earlier transaction, carrying the state NFT and a state inline, the initial one unless given. */
export const controlUtxo = (txId: string, lovelace = CONTROL_LOVELACE, state: PlutusData = initialState): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: lovelace, assets: { [stateNftAssetId]: 1n } }, datum: state },
});

/** The control UTxO of the other account, owned by the fixture device too, carrying its own state NFT. */
export const otherControlUtxo = (txId: string): UTxO => ({
  input: { txId, index: 0 },
  output: { address: otherAccountAddress, value: { coins: CONTROL_LOVELACE, assets: { [otherStateNftAssetId]: 1n } }, datum: initialState },
});

/** A grant UTxO of the account at a fictitious earlier transaction: the grant token of its slot and the grant inline. */
export const grantUtxo = (txId: string, grant: Grant = fixtureGrant): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: GRANT_LOVELACE, assets: { [grantAssetIdOf(grant.slot)]: 1n } }, datum: encodeGrant(grant) },
});

/** A fund UTxO at the account address: lovelace only, no datum. */
export const fundUtxo = (txId: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: lovelace } },
});

/** A reserve UTxO at the account address: lovelace under the reserve datum, which the owner alone can spend. */
export const reserveUtxo = (txId: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address: accountAddress, value: { coins: lovelace }, datum: reserveDatum },
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

/** A script that is neither the account script nor an account's stake script: the always succeeding Plutus script. */
export const foreignScript: PlutusScript = plutusScript('4e4d01000033222220051200120011');
export const foreignScriptHash = Cometa.computeScriptHash(foreignScript);

/** The address paying to the foreign script. */
export const foreignScriptAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(foreignScriptHash)).toAddress().toString();

/** A UTxO at an address paying to a script, which only a transaction running that script can spend. */
export const scriptUtxo = (txId: string, address: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address, value: { coins: lovelace } },
});
