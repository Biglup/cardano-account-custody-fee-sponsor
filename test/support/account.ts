import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PlutusData, PlutusScript, RewardAddress, UTxO } from '@biglup/cometa';
import {
  type AccountState,
  type Blueprint,
  type Grant,
  LOGIC_V2_TITLE,
  applyParameters,
  bytes,
  currentLogicScript,
  encodeAccountRedeemer,
  encodeAccountState,
  encodeGrant,
  encodeLogicRedeemer,
  encodeMintRedeemer,
  encodeReserveDatum,
  encodeStakeRedeemer,
  logicScriptHash,
  logicValidator,
  logicVersionScript,
  stakeScript as contractStakeScript,
} from 'cardano-account-custody-offchain';
import { Cometa } from '../../src/cometa.js';

export type { AccountState, Grant };
export { encodeAccountState, encodeGrant };

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

/** The lovelace a UTxO parking a reference script carries in the fixtures. */
export const PARKED_LOVELACE = 30_000_000n;

/** The slot of the fixture grant, the first an account issues. */
export const GRANT_SLOT = 0n;

/** The lovelace the fixture grant allows per call and in total. */
export const GRANT_CAP = 10_000_000n;

/** The lovelace an agent spend reduces the grant's remaining cap by on top of its outputs, ahead of the fee it will pay. */
export const GRANT_FEE_BOUND = 1_500_000n;

/** When the fixture grant expires: far enough out for every validity bound the tests set. */
export const GRANT_EXPIRES_AT = 1_800_000_000_000n;

/** The parameter the fixtures' unknown logic is applied to, which is not the proxy hash and so yields a hash no published version has. */
const OTHER_LOGIC_PARAMETER = '02'.repeat(28);

/** The blueprint of the account custody contract the service ships with, as `aiken build` writes it, for the fixtures and the test service alike. */
export const BLUEPRINT_PATH = fileURLToPath(new URL('../../contract/plutus.json', import.meta.url));

/** The blueprint of the account custody contract. */
const blueprint = JSON.parse(readFileSync(BLUEPRINT_PATH, 'utf8')) as Blueprint;

/** The compiled code of the first validator entry whose title starts with `prefix`; every handler of a validator shares it. */
const compiledCode = (prefix: string): string => {
  const validator = blueprint.validators.find((entry) => entry.title.startsWith(`${prefix}.`));
  if (!validator) {
    throw new Error(`The blueprint has no validator titled ${prefix}`);
  }
  return validator.compiledCode;
};

const plutusScript = (code: string): PlutusScript => ({ type: Cometa.ScriptType.Plutus, bytes: code, version: Cometa.PlutusLanguageVersion.V3 });

/**
 * The account proxy, whose hash is the payment credential of every
 * account and the policy of every account token. It takes no parameters,
 * so the blueprint's code is the proxy every account on a network shares.
 */
export const accountScript = plutusScript(compiledCode('account.account'));
export const accountScriptHash = Cometa.computeScriptHash(accountScript);

/**
 * The account's stake script: the stake validator applied to the fixture
 * device key as the owner and to the proxy hash, as the contract's own
 * library applies it. Its hash is the stake credential a creation by
 * that device registers, which the policy derives on its own and checks
 * the registration against.
 */
export const stakeScript: PlutusScript = contractStakeScript(DEVICE_KEY, accountScriptHash, blueprint);
export const stakeScriptHash = Cometa.computeScriptHash(stakeScript);

/**
 * The hash the Aiken CLI reports for the stake validator of the committed
 * blueprint once the fixture device key and then the proxy hash are
 * applied to it, each given as the CBOR of its bytes, which the fixture
 * stake script and the service's own derivation must both reach.
 */
export const AIKEN_APPLIED_STAKE_HASH = '4dd785711df2a1a2f5338b73a88e3cd199ed08a6f98e25d13d4db854';

/** The stake validator as the blueprint ships it, before any parameter is applied, whose hash no creation may register. */
export const unappliedStakeScript = plutusScript(compiledCode('account_stake.account_stake'));
export const unappliedStakeScriptHash = Cometa.computeScriptHash(unappliedStakeScript);

/** The stake script hash of another account, whose script the policy never runs either. */
export const otherStakeScriptHash = '11'.repeat(28);

/**
 * The logic the fixture accounts run: the contract's current version
 * applied to the proxy hash, which is what their control datum names and
 * what the zero withdrawal of every operation draws from.
 */
export const logicScript: PlutusScript = currentLogicScript(accountScriptHash, blueprint);
export const logicHash = logicScriptHash(logicScript);

/**
 * The second logic version the blueprint carries, applied to the proxy
 * hash: a real script an upgrade can move an account to, which the
 * service serves only once an operator names its hash.
 */
export const logicV2Script: PlutusScript = logicVersionScript(LOGIC_V2_TITLE, accountScriptHash, blueprint);
export const logicV2Hash = logicScriptHash(logicV2Script);

/** A logic the blueprint carries no version of: the current validator under another parameter, which stands for rules nobody has read. */
export const otherLogicScript: PlutusScript = plutusScript(applyParameters(logicValidator(blueprint).compiledCode, [bytes(OTHER_LOGIC_PARAMETER)]));
export const otherLogicHash = logicScriptHash(otherLogicScript);

/** A script credential. */
export const scriptCredential = (hash: string): { hash: string; type: typeof Cometa.CredentialType.ScriptHash } => ({ hash, type: Cometa.CredentialType.ScriptHash });

/** The reward account of a script credential, which only that script may draw from. */
export const rewardAddressOf = (hash: string): RewardAddress => Cometa.RewardAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(hash));

/** The address of an account: the account proxy paying, the account's stake script staking. */
export const accountAddressOf = (stakeHash: string): string =>
  Cometa.BaseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(accountScriptHash), scriptCredential(stakeHash)).toAddress().toString();

/** The address of the account under test. */
export const accountAddress = accountAddressOf(stakeScriptHash);

/** The address of the other account. */
export const otherAccountAddress = accountAddressOf(otherStakeScriptHash);

/** The reward account of the account's stake script. */
export const accountRewardAddress: RewardAddress = rewardAddressOf(stakeScriptHash);

/** The reward account the zero withdrawal of the fixture accounts' logic draws from. */
export const logicRewardAddress: RewardAddress = rewardAddressOf(logicHash);

/** The reward account the unknown logic's withdrawal draws from. */
export const otherLogicRewardAddress: RewardAddress = rewardAddressOf(otherLogicHash);

/** The asset id of an account's state NFT: the account policy and the stake script hash as the name. */
export const stateNftAssetIdOf = (stakeHash: string): string => `${accountScriptHash}${stakeHash}`;

/** The asset id of the account's state NFT. */
export const stateNftAssetId = stateNftAssetIdOf(stakeScriptHash);

/** The asset id of the other account's state NFT. */
export const otherStateNftAssetId = stateNftAssetIdOf(otherStakeScriptHash);

/** What a creation names of the account a device owns: its stake script and that script's hash, its address, its reward account and its state NFT. */
export interface DeviceAccount {
  stakeScript: PlutusScript;
  stakeScriptHash: string;
  address: string;
  rewardAddress: RewardAddress;
  stateNftAssetId: string;
}

/** The account `device` owns, derived as the contract's own library derives it: the stake validator applied to that device and the proxy hash. */
export const accountOf = (device: string): DeviceAccount => {
  const script = contractStakeScript(device, accountScriptHash, blueprint);
  const hash = Cometa.computeScriptHash(script);
  return { stakeScript: script, stakeScriptHash: hash, address: accountAddressOf(hash), rewardAddress: rewardAddressOf(hash), stateNftAssetId: stateNftAssetIdOf(hash) };
};

/** The name of the grant token of an account's slot: the stake script hash followed by the slot as four big endian bytes. */
export const grantTokenName = (stakeHash: string, slot: bigint): string => `${stakeHash}${slot.toString(16).padStart(8, '0')}`;

/** The asset id of the grant token of the account's slot under the account policy. */
export const grantAssetIdOf = (slot: bigint): string => `${accountScriptHash}${grantTokenName(stakeScriptHash, slot)}`;

/** The asset id of the fixture grant's token. */
export const grantAssetId = grantAssetIdOf(GRANT_SLOT);

/** The state of an account under `logic` owned by `device`: that one device, zero counters, no revoked slot. */
export const initialStateUnder = (logic: string, device: string = DEVICE_KEY): AccountState => ({
  logic,
  devices: [device],
  grantGeneration: 0n,
  nextSlot: 0n,
  revoked: [],
  outstanding: 0n,
});

/** The inline datum of a freshly created account owned by `device`, under the logic the fixtures run. */
export const initialStateOf = (device: string): PlutusData => encodeAccountState(initialStateUnder(logicHash, device));

/** The inline datum of a freshly created account: the fixture device, zero counters, no revoked slot. */
export const initialState: PlutusData = initialStateOf(DEVICE_KEY);

/** The inline datum of a freshly created account naming `logic` in place of the one the fixtures run. */
export const stateUnderLogic = (logic: string): PlutusData => encodeAccountState(initialStateUnder(logic));

/** The control datum of an account that has upgraded to the contract's second logic version. */
export const stateUnderLogicV2: PlutusData = stateUnderLogic(logicV2Hash);

/**
 * A control datum whose first field is not a script hash, as a client
 * writing a state of a shape the proxy cannot read a logic from leaves
 * it: an integer where the logic belongs, and the fixture device listed
 * second as the stake script reads it.
 */
export const stateWithoutLogic: PlutusData = { constructor: 0n, fields: { items: [0n, { items: [bytes(DEVICE_KEY)] }] } };

/** A control datum whose second field is not a list of device keys: the initial state with an integer where the devices belong. */
export const stateWithoutDevices: PlutusData = { constructor: 0n, fields: { items: [bytes(logicHash), 0n] } };

/** The inline datum of a freshly created account listing `devices`, in that order, under the logic the fixtures run. */
export const stateWithDevices = (devices: string[]): PlutusData => encodeAccountState({ ...initialStateUnder(logicHash), devices });

/** The inline datum of the account once it has issued the fixture grant: the next slot and the outstanding count at one. */
export const grantedState: PlutusData = encodeAccountState({ ...initialStateUnder(logicHash), nextSlot: 1n, outstanding: 1n });

/**
 * The inline datum an upgrade writes back: the logic the account arrives
 * at in the first field and the grant generation one higher, which is
 * what kills every grant issued under the logic it leaves.
 */
export const upgradedState = (logic: string): PlutusData => encodeAccountState({ ...initialStateUnder(logic), grantGeneration: 1n });

/** The fixture grant: slot zero to the agent key under generation zero, the cap per call and in total, no recipient restriction. */
export const fixtureGrant: Grant = {
  slot: GRANT_SLOT,
  grantee: AGENT_KEY,
  generation: 0n,
  scope: {
    asset: { policyId: '', assetName: '' },
    perCallCap: GRANT_CAP,
    cap: GRANT_CAP,
    lovelacePerCallCap: 0n,
    lovelaceCap: 0n,
    expiresAt: GRANT_EXPIRES_AT,
    recipients: [],
  },
};

/** The grant after a spend that pays `lovelace` away: the remaining cap reduced by the payout and the fee bound, as the contract's builder writes it. */
export const grantAfterSpend = (grant: Grant, lovelace: bigint): Grant => ({ ...grant, scope: { ...grant.scope, cap: grant.scope.cap - lovelace - GRANT_FEE_BOUND } });

/** The spend redeemers of the account proxy; none carries data. */
export const deviceRedeemer: PlutusData = encodeAccountRedeemer({ kind: 'device' });
export const spendWithGrantRedeemer: PlutusData = encodeAccountRedeemer({ kind: 'spendWithGrant' });
export const sweepGrantRedeemer: PlutusData = encodeAccountRedeemer({ kind: 'sweepGrant' });
export const fundRedeemer: PlutusData = encodeAccountRedeemer({ kind: 'fund' });

/** The mint redeemers of the account proxy; none carries data. */
export const createAccountRedeemer: PlutusData = encodeMintRedeemer({ kind: 'createAccount' });
export const issueGrantsRedeemer: PlutusData = encodeMintRedeemer({ kind: 'issueGrants' });
export const burnGrantsRedeemer: PlutusData = encodeMintRedeemer({ kind: 'burnGrants' });

/** The redeemer of every stake script run, which carries no data. */
export const operateRedeemer: PlutusData = encodeStakeRedeemer();

/** The redeemer of every logic run, which carries no data. */
export const runRedeemer: PlutusData = encodeLogicRedeemer();

/** The datum a reserve carries: constructor zero with no fields, which the validator never reads. */
export const reserveDatum: PlutusData = encodeReserveDatum();

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

/** A script that is neither the account proxy, an account's stake script nor a logic: the always succeeding Plutus script. */
export const foreignScript: PlutusScript = plutusScript('4e4d01000033222220051200120011');
export const foreignScriptHash = Cometa.computeScriptHash(foreignScript);

/** The address paying to the foreign script. */
export const foreignScriptAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(foreignScriptHash)).toAddress().toString();

/**
 * The always fail script the setup of a network parks its reference
 * scripts under, so that nobody can spend the UTxOs holding them. The
 * fixtures name its hash and never run it.
 */
export const parkingScriptHash = 'ab'.repeat(28);

/** The address the reference scripts of the fixtures are parked at. */
export const parkingAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(parkingScriptHash)).toAddress().toString();

/** A UTxO parking a script as a reference script, as the setup of a network leaves it for every transaction to reference. */
export const parkedScriptUtxo = (txId: string, index: number, script: PlutusScript): UTxO => ({
  input: { txId, index },
  output: { address: parkingAddress, value: { coins: PARKED_LOVELACE }, scriptReference: script },
});

/** The transaction the fixtures' parked reference scripts sit in. */
export const PARKED_SCRIPTS_TX = 'cc'.repeat(32);

/** The parked UTxO a transaction references the account proxy from. */
export const parkedProxyUtxo: UTxO = parkedScriptUtxo(PARKED_SCRIPTS_TX, 0, accountScript);

/** The parked UTxO a transaction references the logic the fixture accounts run from. */
export const parkedLogicUtxo: UTxO = parkedScriptUtxo(PARKED_SCRIPTS_TX, 1, logicScript);

/** The parked UTxO an upgrade references the contract's second logic version from. */
export const parkedLogicV2Utxo: UTxO = parkedScriptUtxo(PARKED_SCRIPTS_TX, 2, logicV2Script);

/** The parked UTxO the unknown logic sits at, which a transaction may reference without any account naming it. */
export const parkedOtherLogicUtxo: UTxO = parkedScriptUtxo(PARKED_SCRIPTS_TX, 3, otherLogicScript);

/** A UTxO at an address paying to a script, which only a transaction running that script can spend. */
export const scriptUtxo = (txId: string, address: string, lovelace: bigint): UTxO => ({
  input: { txId, index: 0 },
  output: { address, value: { coins: lovelace } },
});
