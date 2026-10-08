import type { AssetAmounts, Credential, PlutusLanguageVersion, Provider } from '@biglup/cometa';
import { Cometa } from '../cometa.js';
import type { PoolUtxo } from '../pool/utxo.js';
import { utxoRef } from '../pool/utxo.js';
import { type SlotSettings, slotAt, slotToTime } from '../slots.js';
import { evaluates } from './evaluate.js';
import { type ParsedCertificate, type ParsedOutput, type ParsedTransaction, type ResolvedInput, plutusLanguageOf } from './parse.js';
import { type WitnessScriptData, scriptIntegrityHash, witnessScriptData } from './script-data.js';

/**
 * The machine name of a policy rule, listed in the order the rules are
 * checked; the first one that fails is the one reported. Two rules take
 * a different name in each mode, since what they ask differs: the sponsor
 * inputs and the sponsor outflow rules.
 */
export type RuleName =
  | 'well_formed'
  | 'uses_leased_fee_input'
  | 'no_sponsor_inputs'
  | 'uses_shared_collateral'
  | 'bounded_validity'
  | 'account_transaction'
  | 'known_logic'
  | 'sponsor_outflow_bounded'
  | 'sponsor_outflow_zero'
  | 'no_sponsor_value_elsewhere'
  | 'no_foreign_scripts'
  | 'script_data_hash'
  | 'evaluates'
  | 'signers';

/** Why a transaction is refused: the rule that failed and a sentence saying how. */
export interface Violation {
  rule: RuleName;
  detail: string;
}

/** A sponsor UTxO as the policy needs it: where it is and what it holds. */
export type SponsorUtxo = Pick<PoolUtxo, 'txHash' | 'index' | 'lovelace'>;

/** The sponsor paying the fee from the UTxO a lease reserved, which the transaction must spend, until the lease expiry. */
export interface FeeMode {
  kind: 'fee';
  fee: SponsorUtxo;
  expiresAt: string;
}

/** The sponsor contributing the shared collateral alone, with the fee paid by whoever else signs. */
export interface CollateralMode {
  kind: 'collateral';
}

/** How the sponsor takes part in the transaction under check. */
export type PolicyMode = FeeMode | CollateralMode;

/**
 * What the policy knows about the sponsor, the account contract, the mode
 * the transaction is checked under, the shared collateral every
 * transaction declares, the limits, the network's clock and the time of
 * the check.
 */
export interface PolicyContext {
  sponsor: { address: string; paymentKeyHash: string; stakeKeyHash: string };
  accountScriptHash: string;
  /** The logic scripts the service serves accounts under, by hash. */
  knownLogicHashes: Set<string>;
  mode: PolicyMode;
  collateral: SponsorUtxo;
  limits: { maxSponsoredLovelace: number; maxFeeLovelace: number; validityMarginSeconds: number; collateralValiditySeconds: number };
  slots: SlotSettings;
  now: Date;
  /** Whether the pool knows a `txHash#index` reference as one of the sponsor's own UTxOs, whatever its status. */
  isSponsorUtxo: (ref: string) => boolean;
}

/** What kind of account transaction a transaction is: creating an account, or operating an existing one. */
export type TransactionKind = 'creation' | 'operation';

/** What the transaction was read as, which every verdict carries. */
interface Reading {
  kind: TransactionKind | undefined;
  sponsoredLovelace: bigint;
}

/** The verdict on a transaction that broke a rule: the first violation found. */
export interface PolicyRefusal extends Reading {
  violation: Violation;
}

/** The verdict on a transaction that passed every rule, with the validity upper bound the bounded validity rule verified. */
export interface PolicyApproval extends Reading {
  violation: undefined;
  invalidHereafter: bigint;
}

/** The verdict of the policy: a refusal naming the first violation, or an approval carrying the verified validity upper bound. */
export type PolicyVerdict = PolicyRefusal | PolicyApproval;

/** The parts of an account creation the outflow rule accounts for: the registration deposit and the control output. */
interface Creation {
  registration: ParsedCertificate;
  deposit: bigint;
  controlOutput: ParsedOutput;
}

/**
 * An input or reference input that holds a token of an account: the
 * control UTxO under the state NFT, named after the account's stake
 * script hash, or a grant UTxO under a grant token, named after that hash
 * and a slot. The account is the hash the token name starts with.
 */
interface AccountTokenInput {
  input: ResolvedInput;
  account: string;
  kind: 'control' | 'grant';
}

/**
 * A logic script the transaction names, and where it names it: the datum
 * of a control UTxO it spends or references, or the datum of a control
 * output it writes, which is how a creation chooses its logic and an
 * upgrade moves an account to another one. The hash is undefined when the
 * datum names nothing a script hash could be read from.
 */
interface NamedLogic {
  logic: string | undefined;
  where: string;
}

/** The transaction classified against the sponsor and the account contract, which every rule after the first reads. */
interface Analysis {
  transaction: ParsedTransaction;
  inputs: ResolvedInput[];
  referenceInputs: ResolvedInput[];
  sponsorInputs: ResolvedInput[];
  otherInputs: ResolvedInput[];
  accountTokenInputs: AccountTokenInput[];
  referencedControls: AccountTokenInput[];
  sponsorOutputs: ParsedOutput[];
  accountOutputs: ParsedOutput[];
  foreignOutputs: ParsedOutput[];
  kind: TransactionKind | undefined;
  creation: Creation | undefined;
  /** Why the transaction is neither an operation nor a creation, when it is neither. */
  notAccountTransaction: string | undefined;
  stakeScriptHashes: Set<string>;
  /** Every logic the transaction names, with where it names it, for the known logic rule to judge. */
  namedLogics: NamedLogic[];
  /** The logic credentials a withdrawal may draw from: those the named logics resolve to. */
  logicHashes: Set<string>;
  sponsoredLovelace: bigint;
}

/** A rule after the first: reads the analysis and names how the transaction breaks it, or nothing. */
type Rule = (analysis: Analysis, context: PolicyContext) => Violation | undefined;

/** The key lovelace takes in a balance, next to asset ids. */
const LOVELACE = 'lovelace';

/** The hex length of a state NFT name: the 28 byte stake script hash of its account. */
const STATE_NFT_NAME_LENGTH = 56;

/** The hex length of a grant token name: the stake script hash followed by the grant's slot as four bytes. */
const GRANT_TOKEN_NAME_LENGTH = 64;

/** The quantity of every asset, lovelace included, a list of outputs holds in total. */
const balanceOf = (outputs: ParsedOutput[]): AssetAmounts => {
  const balance: AssetAmounts = {};
  for (const output of outputs) {
    balance[LOVELACE] = (balance[LOVELACE] ?? 0n) + output.lovelace;
    for (const [assetId, quantity] of Object.entries(output.assets)) {
      balance[assetId] = (balance[assetId] ?? 0n) + quantity;
    }
  }
  return balance;
};

/** The outputs the resolved inputs spend, leaving out the ones the chain does not know. */
const outputsOf = (inputs: ResolvedInput[]): ParsedOutput[] =>
  inputs.flatMap((input) => (input.output === undefined ? [] : [input.output]));

/** Whether a credential is a script hash. */
const isScript = (credential: Credential | undefined): credential is Credential =>
  credential !== undefined && credential.type === Cometa.CredentialType.ScriptHash;

/** Whether a credential is a key hash. */
const isKey = (credential: Credential | undefined): credential is Credential =>
  credential !== undefined && credential.type === Cometa.CredentialType.KeyHash;

/** Whether an output sits at an account address: one paying to the account script. */
const isAccountOutput = (output: ParsedOutput, context: PolicyContext): boolean =>
  isScript(output.paymentCredential) && output.paymentCredential.hash === context.accountScriptHash;

/** The kind of account token a token name under the account policy denotes, by its length, or undefined for a name of neither shape. */
const tokenKindOf = (name: string): AccountTokenInput['kind'] | undefined =>
  name.length === STATE_NFT_NAME_LENGTH ? 'control' : name.length === GRANT_TOKEN_NAME_LENGTH ? 'grant' : undefined;

/**
 * The account token an input holds, when it is a control or a grant UTxO
 * of an account: the output sits at an account address whose stake part
 * is a script, and holds a token under the account policy named after
 * that very script, alone or followed by a slot. The validator mints a
 * token only into such an output, so an output shaped otherwise belongs
 * to no account and is never read as one. The control token wins when an
 * output holds both kinds.
 */
const accountTokenOf = (input: ResolvedInput, context: PolicyContext): AccountTokenInput | undefined => {
  const output = input.output;
  if (output === undefined || !isAccountOutput(output, context) || !isScript(output.stakeCredential)) {
    return undefined;
  }
  const account = output.stakeCredential.hash;
  const kinds = Object.entries(output.assets).flatMap(([assetId, quantity]) => {
    const name = assetId.slice(context.accountScriptHash.length);
    const kind = tokenKindOf(name);
    return assetId.startsWith(context.accountScriptHash) && quantity > 0n && kind !== undefined && name.startsWith(account) ? [kind] : [];
  });
  const kind = kinds.includes('control') ? 'control' : kinds[0];
  return kind === undefined ? undefined : { input, account, kind };
};

/**
 * The account a control output belongs to: an output at an account
 * address whose stake part is a script, holding the state NFT named
 * after that very script. The validator pins the state NFT to such an
 * output on every spend and at creation, so this is what names the logic
 * the account runs once the transaction lands.
 */
const controlOutputAccount = (output: ParsedOutput, context: PolicyContext): string | undefined => {
  if (!isAccountOutput(output, context) || !isScript(output.stakeCredential)) {
    return undefined;
  }
  const account = output.stakeCredential.hash;
  return output.assets[`${context.accountScriptHash}${account}`] === 1n ? account : undefined;
};

/**
 * Every logic the transaction names: the one each control UTxO it spends
 * or references names in its datum, and the one each control output it
 * writes names. A creation names its initial logic in the one and only
 * control output it writes, and an upgrade names the logic it leaves in
 * the control UTxO it spends and the one it arrives at in the control
 * output, which is why both are read and both withdraw.
 */
const namedLogicsOf = (controls: AccountTokenInput[], transaction: ParsedTransaction, context: PolicyContext): NamedLogic[] => [
  ...controls.map((control) => ({
    logic: control.input.output?.logicHash,
    where: `The control UTxO ${control.input.ref} of account ${control.account}`,
  })),
  ...transaction.outputs.flatMap((output) => {
    const account = controlOutputAccount(output, context);
    return account === undefined ? [] : [{ logic: output.logicHash, where: `The control output of account ${account}` }];
  }),
];

/** Whether a credential is the key the sponsor pays with or stakes with, whatever the view calls it. */
const namesSponsorKey = (credential: Credential, sponsor: PolicyContext['sponsor']): boolean =>
  credential.hash === sponsor.paymentKeyHash || credential.hash === sponsor.stakeKeyHash;

/**
 * Whether an input is one of the sponsor's: the pool knows it, or it is
 * locked by the sponsor payment key at any base, enterprise or pointer
 * address. The sponsor's signature authorises every such input, not only
 * those at the pool's own address, so every one of them counts.
 */
const isSponsorInput = (input: ResolvedInput, context: PolicyContext): boolean =>
  context.isSponsorUtxo(input.ref) ||
  (isKey(input.output?.paymentCredential) && input.output.paymentCredential.hash === context.sponsor.paymentKeyHash);

/**
 * The stake scripts of the accounts this transaction belongs to: those of
 * the control UTxOs it spends or references, which are the names of their
 * state NFTs, or the one it registers at creation. They are never read
 * off outputs, which anyone can shape at will, nor off a grant UTxO
 * alone: an agent spend references the control UTxO of its account, and
 * that is what names the stake script.
 */
const stakeScriptHashesOf = (controls: AccountTokenInput[], creation: Creation | undefined): Set<string> => {
  const hashes = new Set(controls.map((control) => control.account));
  if (creation !== undefined && isScript(creation.registration.credential)) {
    hashes.add(creation.registration.credential.hash);
  }
  return hashes;
};

/** What the transaction was read as: an operation, a creation with its parts, or neither, with the reason. */
type AccountReading =
  | { kind: 'operation'; creation?: never; reason?: never }
  | { kind: 'creation'; creation: Creation; reason?: never }
  | { kind: undefined; creation?: never; reason: string };

/**
 * Reads an account creation out of the transaction, or the reason it is
 * not one: exactly one token minted under the account policy, named with
 * the 28 bytes of a stake script hash, exactly one registration of a
 * script stake credential with an explicit deposit, the token named after
 * that credential and sitting in exactly one output at an account
 * address staked to that same credential.
 */
const readCreation = (transaction: ParsedTransaction, context: PolicyContext): Creation | string => {
  const minted = Object.entries(transaction.mint).filter(([assetId]) => assetId.startsWith(context.accountScriptHash));
  if (minted.length === 0) {
    return 'No input is an account control or grant UTxO and nothing is minted under the account policy';
  }
  const [assetId, quantity] = minted[0] as [string, bigint];
  if (minted.length !== 1 || quantity !== 1n) {
    return 'An account creation mints exactly one token under the account policy';
  }
  if (tokenKindOf(assetId.slice(context.accountScriptHash.length)) !== 'control') {
    return 'An account creation mints a state NFT named with the 28 bytes of its stake script hash';
  }
  const registrations = transaction.certificates.filter(
    (certificate) => certificate.kind === 'registration' && isScript(certificate.credential) && certificate.deposit !== undefined,
  );
  const registration = registrations[0];
  if (registration === undefined || registrations.length !== 1) {
    return 'An account creation registers exactly one script stake credential with its deposit';
  }
  if (assetId.slice(context.accountScriptHash.length) !== registration.credential?.hash) {
    return 'The minted state NFT must be named after the registered stake credential';
  }
  const holders = transaction.outputs.filter((output) => output.assets[assetId] === 1n);
  const controlOutput = holders[0];
  if (controlOutput === undefined || holders.length !== 1 || !isAccountOutput(controlOutput, context)) {
    return 'The minted state NFT must sit in exactly one output at an account address';
  }
  if (controlOutput.stakeCredential?.hash !== registration.credential.hash) {
    return 'The control output must be staked to the registered stake credential';
  }
  return { registration, deposit: registration.deposit ?? 0n, controlOutput };
};

/**
 * Reads what the transaction does to the account contract. Every control
 * UTxO it references must belong to an account whose control or grant
 * UTxO it spends: a referenced control UTxO of any other account serves
 * no path of the validator and is refused outright. A transaction that
 * spends an account token is an operation, and every account it operates
 * must have its control UTxO spent or referenced, as the validator needs
 * on the owner, the sweep and the agent path alike. One that spends none
 * is a creation, or no account transaction at all.
 */
const readAccountTransaction = (
  transaction: ParsedTransaction,
  accountTokenInputs: AccountTokenInput[],
  referencedControls: AccountTokenInput[],
  context: PolicyContext,
): AccountReading => {
  const operated = new Set(accountTokenInputs.map((token) => token.account));
  const foreignControl = referencedControls.find((control) => !operated.has(control.account));
  if (foreignControl !== undefined) {
    return { kind: undefined, reason: `Reference input ${foreignControl.input.ref} is the control UTxO of account ${foreignControl.account}, which no input operates` };
  }
  if (accountTokenInputs.length === 0) {
    const creation = readCreation(transaction, context);
    return typeof creation === 'string' ? { kind: undefined, reason: creation } : { kind: 'creation', creation };
  }
  const present = new Set([...accountTokenInputs, ...referencedControls].filter((token) => token.kind === 'control').map((token) => token.account));
  const orphan = accountTokenInputs.find((token) => !present.has(token.account));
  if (orphan !== undefined) {
    return { kind: undefined, reason: `Input ${orphan.input.ref} is a grant UTxO of account ${orphan.account}, whose control UTxO is neither spent nor referenced` };
  }
  return { kind: 'operation' };
};

/**
 * Classifies the transaction's inputs, reference inputs and outputs
 * against the sponsor and the account contract. A transaction spending a
 * control or a grant UTxO is an operation on that account, read against
 * the control UTxOs it spends or references; one spending neither is read
 * as a creation, or as no account transaction at all. A reference input
 * is never an input: a UTxO at a foreign address, as the one a reference
 * script is parked at, is read as neither the sponsor's nor an account's,
 * and a reference input holding an account token is read as a control
 * UTxO only when it sits at the account address the token names.
 */
const analyse = (transaction: ParsedTransaction, inputs: ResolvedInput[], referenceInputs: ResolvedInput[], context: PolicyContext): Analysis => {
  const sponsorInputs = inputs.filter((input) => isSponsorInput(input, context));
  const otherInputs = inputs.filter((input) => !isSponsorInput(input, context));
  const accountTokenInputs = otherInputs.flatMap((input) => accountTokenOf(input, context) ?? []);
  const referencedControls = referenceInputs.flatMap((input) => accountTokenOf(input, context) ?? []).filter((token) => token.kind === 'control');
  const sponsorOutputs = transaction.outputs.filter((output) => output.address === context.sponsor.address);
  const accountOutputs = transaction.outputs.filter((output) => output.address !== context.sponsor.address && isAccountOutput(output, context));
  const foreignOutputs = transaction.outputs.filter((output) => !sponsorOutputs.includes(output) && !accountOutputs.includes(output));
  const reading = readAccountTransaction(transaction, accountTokenInputs, referencedControls, context);
  const controls = [...accountTokenInputs.filter((token) => token.kind === 'control'), ...referencedControls];
  const namedLogics = namedLogicsOf(controls, transaction, context);
  const returned = balanceOf(sponsorOutputs)[LOVELACE] ?? 0n;
  return {
    transaction,
    inputs,
    referenceInputs,
    sponsorInputs,
    otherInputs,
    accountTokenInputs,
    referencedControls,
    sponsorOutputs,
    accountOutputs,
    foreignOutputs,
    kind: reading.kind,
    creation: reading.creation,
    notAccountTransaction: reading.reason,
    stakeScriptHashes: stakeScriptHashesOf(controls, reading.creation),
    namedLogics,
    logicHashes: new Set(namedLogics.flatMap((named) => (named.logic === undefined ? [] : [named.logic]))),
    sponsoredLovelace: context.mode.kind === 'fee' ? BigInt(context.mode.fee.lovelace) - returned : 0n,
  };
};

/** A violation of a rule. */
const violation = (rule: RuleName, detail: string): Violation => ({ rule, detail });

/**
 * In fee mode, the inputs include the leased fee UTxO and no other UTxO of
 * the sponsor; in collateral mode, no input is the sponsor's at all. In
 * either, an input the chain knows but whose payment credential cannot be
 * read, as at a Byron address, cannot be told from the sponsor's and is
 * refused too.
 */
const sponsorInputs: Rule = ({ inputs, sponsorInputs }, { mode }) => {
  const rule = mode.kind === 'fee' ? 'uses_leased_fee_input' : 'no_sponsor_inputs';
  const feeRef = mode.kind === 'fee' ? utxoRef(mode.fee.txHash, mode.fee.index) : undefined;
  if (feeRef !== undefined && !inputs.some((input) => input.ref === feeRef)) {
    return violation(rule, `The leased fee UTxO ${feeRef} is not among the inputs`);
  }
  const unclassifiable = inputs.find((input) => input.output !== undefined && input.output.paymentCredential === undefined);
  if (unclassifiable !== undefined) {
    return violation(rule, `Input ${unclassifiable.ref} is at an address whose payment credential the policy cannot read`);
  }
  const extra = sponsorInputs.find((input) => input.ref !== feeRef);
  if (extra !== undefined) {
    return violation(
      rule,
      feeRef === undefined
        ? `Input ${extra.ref} belongs to the sponsor, which contributes collateral only`
        : `Input ${extra.ref} belongs to the sponsor but is not the leased fee UTxO`,
    );
  }
  return undefined;
};

/**
 * The collateral is exactly the shared collateral UTxO, returned to the
 * sponsor, with total collateral set within what it holds, and the
 * transaction is not flagged as failing phase two, which would hand the
 * collateral to the ledger outright. The same UTxO is named by the lease
 * in fee mode and by the collateral route in the other, so the rule
 * answers under one name in both.
 */
const sponsorCollateral: Rule = ({ transaction }, { collateral, sponsor }) => {
  const rule = 'uses_shared_collateral';
  if (!transaction.isValid) {
    return violation(rule, 'The transaction is flagged as failing phase two, which would forfeit the collateral');
  }
  const collateralRef = utxoRef(collateral.txHash, collateral.index);
  const refs = transaction.collateralInputs.map((input) => utxoRef(input.txId, input.index));
  if (refs.length !== 1 || refs[0] !== collateralRef) {
    return violation(rule, `The collateral inputs must be exactly the shared collateral UTxO ${collateralRef}`);
  }
  if (transaction.collateralReturn === undefined) {
    return violation(rule, 'The transaction has no collateral return output');
  }
  if (transaction.collateralReturn.address !== sponsor.address) {
    return violation(rule, 'The collateral return must pay the sponsor address');
  }
  const carried = carries(transaction.collateralReturn);
  if (carried !== undefined) {
    return violation(rule, `The collateral return carries a ${carried}, which the pool could not spend plainly`);
  }
  if (transaction.totalCollateral === undefined) {
    return violation(rule, 'Total collateral is not set');
  }
  if (transaction.totalCollateral > BigInt(collateral.lovelace)) {
    return violation(rule, `Total collateral ${transaction.totalCollateral} exceeds the ${collateral.lovelace} lovelace the shared collateral UTxO holds`);
  }
  return undefined;
};

/** The latest slot a validity upper bound may name under the mode, and the words for how it was found. */
const latestBound = ({ mode, limits, slots, now }: PolicyContext): { slot: bigint; reason: string } =>
  mode.kind === 'fee'
    ? {
        slot: slotAt(slots, new Date(new Date(mode.expiresAt).getTime() + limits.validityMarginSeconds * 1000)),
        reason: `the lease expiry plus ${limits.validityMarginSeconds} seconds`,
      }
    : {
        slot: slotAt(slots, new Date(now.getTime() + limits.collateralValiditySeconds * 1000)),
        reason: `now plus ${limits.collateralValiditySeconds} seconds`,
      };

/**
 * The transaction stops being valid no later than the lease expiry plus
 * the configured margin in fee mode, so that a witnessed transaction the
 * client never submits cannot hold the fee UTxO out of the pool for
 * longer than that, or than now plus the collateral validity window in
 * collateral mode, so that a signed transaction cannot linger; and later
 * than now, so that the bound stored with the witness is one the pool
 * sync can wait out. Slots are compared as the integers they are, never
 * as times: a bound far enough out has no time at all, and must still be
 * refused. Returns the bound once it is verified.
 */
const boundedValidity = ({ transaction }: Analysis, context: PolicyContext): bigint | Violation => {
  const bound = transaction.invalidHereafter;
  if (bound === undefined) {
    return violation('bounded_validity', 'The transaction carries no validity upper bound');
  }
  const latest = latestBound(context);
  if (bound > latest.slot) {
    return violation(
      'bounded_validity',
      `The validity upper bound at slot ${bound} is later than slot ${latest.slot} (${slotToTime(context.slots, latest.slot).toISOString()}), ${latest.reason}`,
    );
  }
  const currentSlot = slotAt(context.slots, context.now);
  if (bound <= currentSlot) {
    return violation(
      'bounded_validity',
      `The validity upper bound at slot ${bound} (${slotToTime(context.slots, bound).toISOString()}) is not later than the current slot ${currentSlot}`,
    );
  }
  return bound;
};

/** The transaction operates an existing account through its control or grant UTxOs, with the control UTxO spent or referenced, or creates one. */
const accountTransaction: Rule = ({ notAccountTransaction }) =>
  notAccountTransaction === undefined ? undefined : violation('account_transaction', notAccountTransaction);

/**
 * Every logic the transaction names is one the service knows. An account
 * runs the rules of the logic its control datum names, and the validator
 * admits any registered script there, so a device that signs an upgrade
 * to a hash the service does not know hands its account to code the
 * service has never read: the sponsor neither pays for nor lends
 * collateral to such an account. A control UTxO or output whose datum
 * names no script hash at all is refused here too, since the validator
 * reads that field and would abort on it.
 */
const knownLogic: Rule = ({ namedLogics }, { knownLogicHashes }) => {
  for (const named of namedLogics) {
    if (named.logic === undefined) {
      return violation('known_logic', `${named.where} names no logic script hash in the first field of its datum`);
    }
    if (!knownLogicHashes.has(named.logic)) {
      return violation('known_logic', `${named.where} names logic ${named.logic}, which is not one of the logic scripts the service knows`);
    }
  }
  return undefined;
};

/** What an output carries beyond its value, when it carries anything: a datum or a reference script. */
const carries = (output: ParsedOutput): 'datum' | 'reference script' | undefined =>
  output.hasDatum ? 'datum' : output.hasReferenceScript ? 'reference script' : undefined;

/**
 * A leased fee UTxO pays for an account creation and for nothing else:
 * an operation on an existing account is paid by the account and takes
 * the collateral route, so it is refused here whatever it draws. What
 * the sponsor's input is drawn down by is then exactly the fee, the
 * registration deposit and the control output, within the limits, and
 * what comes back to the sponsor is one plain change output the pool can
 * spend: change split over several outputs would litter the sponsor
 * address with small UTxOs the pool classifies as reserve.
 */
const sponsorOutflowBounded: Rule = ({ transaction, creation, sponsorOutputs, sponsoredLovelace }, { limits }) => {
  if (creation === undefined) {
    return violation(
      'sponsor_outflow_bounded',
      'The leased fee UTxO pays for an account creation only; an operation on an existing account pays its own fee and takes the collateral route',
    );
  }
  if (transaction.fee > BigInt(limits.maxFeeLovelace)) {
    return violation('sponsor_outflow_bounded', `The fee ${transaction.fee} exceeds the ${limits.maxFeeLovelace} lovelace limit`);
  }
  for (const output of sponsorOutputs) {
    const carried = carries(output);
    if (carried !== undefined) {
      return violation('sponsor_outflow_bounded', `An output to the sponsor carries a ${carried}, which the pool could not spend plainly`);
    }
  }
  if (sponsorOutputs.length !== 1) {
    return violation('sponsor_outflow_bounded', `The transaction pays the sponsor ${sponsorOutputs.length} outputs where exactly one change output is expected`);
  }
  const expected = transaction.fee + creation.deposit + creation.controlOutput.lovelace;
  if (sponsoredLovelace !== expected) {
    return violation(
      'sponsor_outflow_bounded',
      `The sponsor input is drawn down by ${sponsoredLovelace} lovelace but the fee, the registration deposit and the control output account for ${expected}`,
    );
  }
  if (sponsoredLovelace > BigInt(limits.maxSponsoredLovelace)) {
    return violation(
      'sponsor_outflow_bounded',
      `Sponsoring ${sponsoredLovelace} lovelace exceeds the ${limits.maxSponsoredLovelace} lovelace limit`,
    );
  }
  return undefined;
};

/**
 * In collateral mode the sponsor contributes nothing but the collateral:
 * no output pays the sponsor payment key, at any address, and no sponsor
 * value enters the transaction, neither through an input, which the
 * sponsor inputs rule already refused, nor through a withdrawal from the
 * sponsor's reward account.
 */
const sponsorOutflowZero: Rule = ({ transaction }, { sponsor }) => {
  const paid = transaction.outputs.find((output) => isKey(output.paymentCredential) && output.paymentCredential.hash === sponsor.paymentKeyHash);
  if (paid !== undefined) {
    return violation('sponsor_outflow_zero', `An output pays ${paid.lovelace} lovelace to the sponsor, which contributes collateral only`);
  }
  const withdrawal = transaction.withdrawals.find((entry) => isKey(entry.credential) && entry.credential.hash === sponsor.stakeKeyHash);
  if (withdrawal !== undefined) {
    return violation('sponsor_outflow_zero', `The transaction withdraws from the sponsor's reward account ${withdrawal.rewardAddress}, which contributes nothing`);
  }
  return undefined;
};

/** The sponsor outflow rule of the mode: a creation drawing exactly what it costs in fee mode, nothing at all in collateral mode. */
const sponsorOutflow: Rule = (analysis, context) =>
  context.mode.kind === 'fee' ? sponsorOutflowBounded(analysis, context) : sponsorOutflowZero(analysis, context);

/** Every output away from the sponsor and the account is covered by what the non sponsor inputs and withdrawals bring in. */
const noSponsorValueElsewhere: Rule = ({ transaction, otherInputs, foreignOutputs }, { sponsor }) => {
  const supply = balanceOf(outputsOf(otherInputs));
  for (const withdrawal of transaction.withdrawals) {
    if (!(isKey(withdrawal.credential) && withdrawal.credential.hash === sponsor.stakeKeyHash)) {
      supply[LOVELACE] = (supply[LOVELACE] ?? 0n) + withdrawal.lovelace;
    }
  }
  for (const [assetId, demanded] of Object.entries(balanceOf(foreignOutputs))) {
    const supplied = supply[assetId] ?? 0n;
    if (demanded > supplied) {
      return violation(
        'no_sponsor_value_elsewhere',
        `Outputs away from the sponsor and the account need ${demanded} ${assetId === LOVELACE ? 'lovelace' : `of ${assetId}`} but the non sponsor inputs supply ${supplied}`,
      );
    }
  }
  return undefined;
};

/**
 * Every script the transaction runs or attaches belongs to the account:
 * the account proxy, which pays for every account UTxO and mints every
 * account token, one of the account's stake scripts, named by the
 * control UTxOs it spends or references or registered at creation, or
 * one of the logics those control UTxOs and the control outputs name,
 * whose zero withdrawal is how the proxy runs the account's rules. A
 * logic is a stake credential and never pays for an input, mints or
 * appears on a certificate, so it is allowed only where the account
 * needs it: as the credential of a withdrawal, and as an attached script
 * for a transaction that embeds it rather than referencing a parked one.
 * A logic runs on a withdrawal of zero, so one that draws lovelace is
 * refused here as well.
 */
const noForeignScripts: Rule = ({ transaction, inputs, stakeScriptHashes, logicHashes }, { accountScriptHash }) => {
  const allowed = new Set([accountScriptHash, ...stakeScriptHashes]);
  const runnable = new Set([...allowed, ...logicHashes]);
  const foreign = (hash: string): string => `${hash}, which is neither the account script nor its stake script`;
  const unrunnable = (hash: string): string => `${hash}, which is neither the account script, its stake script nor a logic its control UTxOs name`;
  for (const input of inputs) {
    const credential = input.output?.paymentCredential;
    if (isScript(credential) && !allowed.has(credential.hash)) {
      return violation('no_foreign_scripts', `Input ${input.ref} is locked by script ${foreign(credential.hash)}`);
    }
  }
  for (const assetId of Object.keys(transaction.mint)) {
    const policyId = assetId.slice(0, accountScriptHash.length);
    if (!allowed.has(policyId)) {
      return violation('no_foreign_scripts', `The transaction mints under policy ${foreign(policyId)}`);
    }
  }
  for (const certificate of transaction.certificates) {
    const credential = certificate.credentials.find((named) => isScript(named) && !allowed.has(named.hash));
    if (credential !== undefined) {
      return violation('no_foreign_scripts', `The ${certificate.kind} certificate names script ${foreign(credential.hash)}`);
    }
  }
  for (const withdrawal of transaction.withdrawals) {
    if (isScript(withdrawal.credential) && !runnable.has(withdrawal.credential.hash)) {
      return violation('no_foreign_scripts', `A withdrawal draws from script ${unrunnable(withdrawal.credential.hash)}`);
    }
    if (isScript(withdrawal.credential) && logicHashes.has(withdrawal.credential.hash) && withdrawal.lovelace !== 0n) {
      return violation(
        'no_foreign_scripts',
        `The withdrawal that runs logic ${withdrawal.credential.hash} draws ${withdrawal.lovelace} lovelace, and a logic runs on a withdrawal of zero`,
      );
    }
  }
  for (const voter of transaction.voters) {
    if (isScript(voter.credential) && !allowed.has(voter.credential.hash)) {
      return violation('no_foreign_scripts', `The ${voter.kind} voter is script ${foreign(voter.credential.hash)}`);
    }
  }
  if (transaction.nativeScriptCount > 0) {
    return violation('no_foreign_scripts', 'The transaction carries native script witnesses, which no account transaction needs');
  }
  for (const script of transaction.scripts) {
    if (!runnable.has(script.hash)) {
      return violation('no_foreign_scripts', `The transaction attaches script ${unrunnable(script.hash)}`);
    }
  }
  return undefined;
};

/**
 * The Plutus languages the transaction's scripts are written in: those
 * of the scripts it attaches and those of the reference scripts the
 * outputs it spends and references carry. The ledger prices each
 * language under its own cost model, and the language view those models
 * form is part of what the script data hash commits to.
 */
const languagesOf = ({ transaction, inputs, referenceInputs }: Analysis): PlutusLanguageVersion[] => [
  ...transaction.scripts.map((script) => plutusLanguageOf(script.language)),
  ...[...inputs, ...referenceInputs].flatMap((input) => {
    const language = input.output?.referenceScriptLanguage;
    return language === undefined ? [] : [language];
  }),
];

/**
 * The script data hash in the body matches the redeemers and the datums
 * the witness set carries. The body commits to the hash and the
 * sponsor's signature covers the body, but the redeemers and the datums
 * sit in the witness set, which no signature covers, so a client is free
 * to present one set for evaluation and attach another afterwards. The
 * hash is recomputed here from the witness set as it stands, under the
 * cost models the provider reports, and anything but an exact match is
 * refused: a body committing to other script data than it carries, a
 * body committing to none while the witness set carries redeemers or
 * datums, and a body committing to one while it carries neither. Every
 * script an account transaction runs is Plutus V3, so a transaction
 * whose scripts are not all written in it is refused rather than hashed
 * under a language view that would be a guess.
 */
const scriptDataHash = async (analysis: Analysis, provider: Provider): Promise<Violation | undefined> => {
  const { transaction } = analysis;
  const declared = transaction.scriptDataHash;
  let data: WitnessScriptData;
  try {
    data = witnessScriptData(transaction.cbor);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return violation('script_data_hash', `The witness set cannot be read for the script data it carries: ${message}`);
  }
  if (data.redeemers === undefined && data.datums === undefined) {
    return declared === undefined
      ? undefined
      : violation('script_data_hash', `The body commits to the script data hash ${declared} while the witness set carries neither redeemers nor datums`);
  }
  if (declared === undefined) {
    return violation('script_data_hash', 'The witness set carries redeemers or datums while the body commits to no script data hash');
  }
  const languages = languagesOf(analysis);
  const foreign = languages.find((language) => language !== Cometa.PlutusLanguageVersion.V3);
  if (foreign !== undefined) {
    return violation('script_data_hash', `The transaction carries a script of Plutus language ${foreign}, and every script an account runs is Plutus V3`);
  }
  let computed: string | undefined;
  try {
    computed = scriptIntegrityHash(data, languages, await provider.getParameters());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return violation('script_data_hash', `The script data hash cannot be computed: ${message}`);
  }
  return computed === declared
    ? undefined
    : violation('script_data_hash', `The body commits to the script data hash ${declared} while the witness set carries script data hashing to ${computed}`);
};

/**
 * The sponsor signs as a payer only: neither of its keys is a required
 * signer, and nothing in the transaction, be it a withdrawal, a
 * certificate of any kind or a vote, is authorised by a sponsor key.
 */
const signers: Rule = ({ transaction }, { sponsor }) => {
  if (transaction.requiredSigners.includes(sponsor.paymentKeyHash)) {
    return violation('signers', 'The sponsor payment key is among the required signers');
  }
  if (transaction.requiredSigners.includes(sponsor.stakeKeyHash)) {
    return violation('signers', 'The sponsor stake key is among the required signers');
  }
  for (const withdrawal of transaction.withdrawals) {
    if (isKey(withdrawal.credential) && withdrawal.credential.hash === sponsor.stakeKeyHash) {
      return violation('signers', `The transaction withdraws from the sponsor's reward account ${withdrawal.rewardAddress}`);
    }
  }
  for (const certificate of transaction.certificates) {
    if (certificate.credentials.some((credential) => namesSponsorKey(credential, sponsor))) {
      return violation('signers', `The ${certificate.kind} certificate names the sponsor's own credential`);
    }
  }
  for (const voter of transaction.voters) {
    if (namesSponsorKey(voter.credential, sponsor)) {
      return violation('signers', `The ${voter.kind} voter is the sponsor's own credential`);
    }
  }
  return undefined;
};

/** The rules checked before the validity bound, in order. */
const BEFORE_VALIDITY: Rule[] = [sponsorInputs, sponsorCollateral];

/** The rules checked after the validity bound and before evaluation, in order. */
const BEFORE_EVALUATION: Rule[] = [accountTransaction, knownLogic, sponsorOutflow, noSponsorValueElsewhere, noForeignScripts];

/**
 * Applies the policy to a transaction that already parsed, in rule
 * order: the structural rules first, then the script data hash the body
 * commits to, then evaluation through the provider, then the signer
 * rules, stopping at the first violation. The
 * same rules serve both modes; the mode in the context decides what the
 * sponsor inputs, the collateral, the validity bound and the sponsor
 * outflow rules ask, and the name each answers under. The verdict also
 * says what the transaction was read as and how much sponsor lovelace it
 * draws, which is what the audit trail records, and an approval carries
 * the validity upper bound as verified, which is what the witness is
 * recorded with.
 */
export const applyPolicy = async (
  transaction: ParsedTransaction,
  inputs: ResolvedInput[],
  referenceInputs: ResolvedInput[],
  context: PolicyContext,
  provider: Provider,
): Promise<PolicyVerdict> => {
  const analysis = analyse(transaction, inputs, referenceInputs, context);
  const reading: Reading = { kind: analysis.kind, sponsoredLovelace: analysis.sponsoredLovelace };
  const refuse = (found: Violation): PolicyRefusal => ({ ...reading, violation: found });
  for (const rule of BEFORE_VALIDITY) {
    const found = rule(analysis, context);
    if (found !== undefined) {
      return refuse(found);
    }
  }
  const bound = boundedValidity(analysis, context);
  if (typeof bound !== 'bigint') {
    return refuse(bound);
  }
  for (const rule of BEFORE_EVALUATION) {
    const found = rule(analysis, context);
    if (found !== undefined) {
      return refuse(found);
    }
  }
  const committed = await scriptDataHash(analysis, provider);
  if (committed !== undefined) {
    return refuse(committed);
  }
  const evaluation = await evaluates(transaction, inputs, referenceInputs, context, provider);
  if (evaluation !== undefined) {
    return refuse(evaluation);
  }
  const named = signers(analysis, context);
  if (named !== undefined) {
    return refuse(named);
  }
  return { ...reading, violation: undefined, invalidHereafter: bound };
};
