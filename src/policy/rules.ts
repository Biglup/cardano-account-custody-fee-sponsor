import type { AssetAmounts, Credential, Provider } from '@biglup/cometa';
import { Cometa } from '../cometa.js';
import type { PoolUtxo } from '../pool/utxo.js';
import { utxoRef } from '../pool/utxo.js';
import { evaluates } from './evaluate.js';
import type { ParsedCertificate, ParsedOutput, ParsedTransaction, ResolvedInput } from './parse.js';

/** The machine name of a policy rule, listed in the order the rules are checked; the first one that fails is the one reported. */
export type RuleName =
  | 'well_formed'
  | 'uses_leased_fee_input'
  | 'uses_leased_collateral'
  | 'account_transaction'
  | 'sponsor_outflow_bounded'
  | 'no_sponsor_value_elsewhere'
  | 'no_foreign_scripts'
  | 'evaluates'
  | 'signers';

/** Why a transaction is refused: the rule that failed and a sentence saying how. */
export interface Violation {
  rule: RuleName;
  detail: string;
}

/** A leased UTxO as the policy needs it: where it is and what it holds. */
export type LeasedUtxo = Pick<PoolUtxo, 'txHash' | 'index' | 'lovelace'>;

/** What the policy knows about the sponsor, the account contract, the lease under check and its limits. */
export interface PolicyContext {
  sponsor: { address: string; paymentKeyHash: string; stakeKeyHash: string };
  accountScriptHash: string;
  lease: { fee: LeasedUtxo; collateral: LeasedUtxo };
  limits: { maxSponsoredLovelace: number; maxFeeLovelace: number };
  /** Whether the pool knows a `txHash#index` reference as one of the sponsor's own UTxOs, whatever its status. */
  isSponsorUtxo: (ref: string) => boolean;
}

/** What kind of account transaction a transaction is: creating an account, or operating an existing one. */
export type TransactionKind = 'creation' | 'operation';

/** The verdict of the policy: the first violation when there is one, and what the transaction was read as. */
export interface PolicyVerdict {
  violation: Violation | undefined;
  kind: TransactionKind | undefined;
  sponsoredLovelace: bigint;
}

/** The parts of an account creation the outflow rule accounts for: the registration deposit and the control output. */
interface Creation {
  registration: ParsedCertificate;
  deposit: bigint;
  controlOutput: ParsedOutput;
}

/** The transaction classified against the sponsor and the account contract, which every rule after the first reads. */
interface Analysis {
  transaction: ParsedTransaction;
  inputs: ResolvedInput[];
  sponsorInputs: ResolvedInput[];
  otherInputs: ResolvedInput[];
  controlInputs: ResolvedInput[];
  sponsorOutputs: ParsedOutput[];
  accountOutputs: ParsedOutput[];
  foreignOutputs: ParsedOutput[];
  kind: TransactionKind | undefined;
  creation: Creation | undefined;
  /** Why the transaction is neither an operation nor a creation, when it is neither. */
  notAccountTransaction: string | undefined;
  stakeScriptHashes: Set<string>;
  sponsoredLovelace: bigint;
}

/** A rule after the first: reads the analysis and names how the transaction breaks it, or nothing. */
type Rule = (analysis: Analysis, context: PolicyContext) => Violation | undefined;

/** The key lovelace takes in a balance, next to asset ids. */
const LOVELACE = 'lovelace';

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

/** Whether an output is an account's control UTxO: at an account address and holding a token of the account policy. */
const isControlOutput = (output: ParsedOutput, context: PolicyContext): boolean =>
  isAccountOutput(output, context) &&
  Object.entries(output.assets).some(([assetId, quantity]) => assetId.startsWith(context.accountScriptHash) && quantity > 0n);

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
 * the control UTxOs it spends, or the one it registers at creation. They
 * are never read off outputs, which anyone can shape at will.
 */
const stakeScriptHashesOf = (controlInputs: ResolvedInput[], creation: Creation | undefined): Set<string> => {
  const hashes = new Set<string>();
  for (const output of outputsOf(controlInputs)) {
    if (isScript(output.stakeCredential)) {
      hashes.add(output.stakeCredential.hash);
    }
  }
  if (creation !== undefined && isScript(creation.registration.credential)) {
    hashes.add(creation.registration.credential.hash);
  }
  return hashes;
};

/**
 * Reads an account creation out of the transaction, or the reason it is
 * not one: exactly one token minted under the account policy, exactly
 * one registration of a script stake credential with an explicit
 * deposit, the token named after that credential and sitting in exactly
 * one output at an account address staked to that same credential.
 */
const readCreation = (transaction: ParsedTransaction, context: PolicyContext): Creation | string => {
  const minted = Object.entries(transaction.mint).filter(([assetId]) => assetId.startsWith(context.accountScriptHash));
  if (minted.length === 0) {
    return 'No input is an account control UTxO and nothing is minted under the account policy';
  }
  const [assetId, quantity] = minted[0] as [string, bigint];
  if (minted.length !== 1 || quantity !== 1n) {
    return 'An account creation mints exactly one token under the account policy';
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

/** Classifies the transaction's inputs and outputs against the sponsor and the account contract. */
const analyse = (transaction: ParsedTransaction, inputs: ResolvedInput[], context: PolicyContext): Analysis => {
  const sponsorInputs = inputs.filter((input) => isSponsorInput(input, context));
  const otherInputs = inputs.filter((input) => !isSponsorInput(input, context));
  const controlInputs = otherInputs.filter((input) => input.output !== undefined && isControlOutput(input.output, context));
  const sponsorOutputs = transaction.outputs.filter((output) => output.address === context.sponsor.address);
  const accountOutputs = transaction.outputs.filter((output) => output.address !== context.sponsor.address && isAccountOutput(output, context));
  const foreignOutputs = transaction.outputs.filter((output) => !sponsorOutputs.includes(output) && !accountOutputs.includes(output));
  const creation = controlInputs.length > 0 ? undefined : readCreation(transaction, context);
  const returned = balanceOf(sponsorOutputs)[LOVELACE] ?? 0n;
  return {
    transaction,
    inputs,
    sponsorInputs,
    otherInputs,
    controlInputs,
    sponsorOutputs,
    accountOutputs,
    foreignOutputs,
    kind: controlInputs.length > 0 ? 'operation' : typeof creation === 'string' ? undefined : 'creation',
    creation: typeof creation === 'string' ? undefined : creation,
    notAccountTransaction: typeof creation === 'string' ? creation : undefined,
    stakeScriptHashes: stakeScriptHashesOf(controlInputs, typeof creation === 'string' ? undefined : creation),
    sponsoredLovelace: BigInt(context.lease.fee.lovelace) - returned,
  };
};

/** A violation of a rule. */
const violation = (rule: RuleName, detail: string): Violation => ({ rule, detail });

/**
 * The inputs include the leased fee UTxO and no other UTxO of the
 * sponsor. An input the chain knows but whose payment credential cannot
 * be read, as at a Byron address, cannot be told from the sponsor's and
 * is refused too.
 */
const usesLeasedFeeInput: Rule = ({ inputs, sponsorInputs }, { lease }) => {
  const feeRef = utxoRef(lease.fee.txHash, lease.fee.index);
  if (!inputs.some((input) => input.ref === feeRef)) {
    return violation('uses_leased_fee_input', `The leased fee UTxO ${feeRef} is not among the inputs`);
  }
  const unclassifiable = inputs.find((input) => input.output !== undefined && input.output.paymentCredential === undefined);
  if (unclassifiable !== undefined) {
    return violation('uses_leased_fee_input', `Input ${unclassifiable.ref} is at an address whose payment credential the policy cannot read`);
  }
  const extra = sponsorInputs.find((input) => input.ref !== feeRef);
  if (extra !== undefined) {
    return violation('uses_leased_fee_input', `Input ${extra.ref} belongs to the sponsor but is not the leased fee UTxO`);
  }
  return undefined;
};

/**
 * The collateral is exactly the leased collateral UTxO, returned to the
 * sponsor, with total collateral set within what it holds, and the
 * transaction is not flagged as failing phase two, which would hand the
 * collateral to the ledger outright.
 */
const usesLeasedCollateral: Rule = ({ transaction }, { lease, sponsor }) => {
  if (!transaction.isValid) {
    return violation('uses_leased_collateral', 'The transaction is flagged as failing phase two, which would forfeit the collateral');
  }
  const collateralRef = utxoRef(lease.collateral.txHash, lease.collateral.index);
  const refs = transaction.collateralInputs.map((input) => utxoRef(input.txId, input.index));
  if (refs.length !== 1 || refs[0] !== collateralRef) {
    return violation('uses_leased_collateral', `The collateral inputs must be exactly the leased collateral UTxO ${collateralRef}`);
  }
  if (transaction.collateralReturn === undefined) {
    return violation('uses_leased_collateral', 'The transaction has no collateral return output');
  }
  if (transaction.collateralReturn.address !== sponsor.address) {
    return violation('uses_leased_collateral', 'The collateral return must pay the sponsor address');
  }
  const carried = carries(transaction.collateralReturn);
  if (carried !== undefined) {
    return violation('uses_leased_collateral', `The collateral return carries a ${carried}, which the pool could not spend plainly`);
  }
  if (transaction.totalCollateral === undefined) {
    return violation('uses_leased_collateral', 'Total collateral is not set');
  }
  if (transaction.totalCollateral > BigInt(lease.collateral.lovelace)) {
    return violation(
      'uses_leased_collateral',
      `Total collateral ${transaction.totalCollateral} exceeds the ${lease.collateral.lovelace} lovelace the leased collateral UTxO holds`,
    );
  }
  return undefined;
};

/** The transaction operates an existing account through its control UTxO, or creates one. */
const accountTransaction: Rule = ({ notAccountTransaction }) =>
  notAccountTransaction === undefined ? undefined : violation('account_transaction', notAccountTransaction);

/** What an output carries beyond its value, when it carries anything: a datum or a reference script. */
const carries = (output: ParsedOutput): 'datum' | 'reference script' | undefined =>
  output.hasDatum ? 'datum' : output.hasReferenceScript ? 'reference script' : undefined;

/**
 * What the sponsor's input is drawn down by is exactly the fee, plus the
 * deposit and the control output at creation, within the limits, and
 * what comes back to the sponsor is plain lovelace the pool can spend.
 */
const sponsorOutflowBounded: Rule = ({ transaction, creation, sponsorOutputs, sponsoredLovelace }, { limits }) => {
  if (transaction.fee > BigInt(limits.maxFeeLovelace)) {
    return violation('sponsor_outflow_bounded', `The fee ${transaction.fee} exceeds the ${limits.maxFeeLovelace} lovelace limit`);
  }
  for (const output of sponsorOutputs) {
    const carried = carries(output);
    if (carried !== undefined) {
      return violation('sponsor_outflow_bounded', `An output to the sponsor carries a ${carried}, which the pool could not spend plainly`);
    }
  }
  const expected = transaction.fee + (creation === undefined ? 0n : creation.deposit + creation.controlOutput.lovelace);
  if (sponsoredLovelace !== expected) {
    const accounted = creation === undefined ? 'the fee accounts' : 'the fee, the registration deposit and the control output account';
    return violation(
      'sponsor_outflow_bounded',
      `The sponsor input is drawn down by ${sponsoredLovelace} lovelace but ${accounted} for ${expected}`,
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

/** Every script the transaction runs or attaches is the account script or one of the account's stake scripts. */
const noForeignScripts: Rule = ({ transaction, inputs, stakeScriptHashes }, { accountScriptHash }) => {
  const allowed = new Set([accountScriptHash, ...stakeScriptHashes]);
  const foreign = (hash: string): string => `${hash}, which is neither the account script nor its stake script`;
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
    if (isScript(withdrawal.credential) && !allowed.has(withdrawal.credential.hash)) {
      return violation('no_foreign_scripts', `A withdrawal draws from script ${foreign(withdrawal.credential.hash)}`);
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
    if (!allowed.has(script.hash)) {
      return violation('no_foreign_scripts', `The transaction attaches script ${foreign(script.hash)}`);
    }
  }
  return undefined;
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

/** The rules checked before evaluation, in order. */
const BEFORE_EVALUATION: Rule[] = [
  usesLeasedFeeInput,
  usesLeasedCollateral,
  accountTransaction,
  sponsorOutflowBounded,
  noSponsorValueElsewhere,
  noForeignScripts,
];

/**
 * Applies the policy to a transaction that already parsed, in rule
 * order: the structural rules first, then evaluation through the
 * provider, then the signer rules, stopping at the first violation. The
 * verdict also says what the transaction was read as and how much
 * sponsor lovelace it draws, which is what the audit trail records.
 */
export const applyPolicy = async (
  transaction: ParsedTransaction,
  inputs: ResolvedInput[],
  context: PolicyContext,
  provider: Provider,
): Promise<PolicyVerdict> => {
  const analysis = analyse(transaction, inputs, context);
  const verdict = (found: Violation | undefined): PolicyVerdict => ({
    violation: found,
    kind: analysis.kind,
    sponsoredLovelace: analysis.sponsoredLovelace,
  });
  for (const rule of BEFORE_EVALUATION) {
    const found = rule(analysis, context);
    if (found !== undefined) {
      return verdict(found);
    }
  }
  const evaluation = await evaluates(transaction, inputs, context, provider);
  if (evaluation !== undefined) {
    return verdict(evaluation);
  }
  return verdict(signers(analysis, context));
};
