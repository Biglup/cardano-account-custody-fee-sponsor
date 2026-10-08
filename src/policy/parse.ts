import type { AssetAmounts, Credential, PlutusData, PlutusLanguageVersion, Provider, RedeemerPurpose, TxIn, TxOut, UTxO } from '@biglup/cometa';
import { z } from 'zod';
import { Cometa } from '../cometa.js';
import { utxoRef } from '../pool/utxo.js';
import { transactionHash } from '../transaction-hash.js';
import type { Violation } from './rules.js';

/** The largest transaction the service inspects, which is also the protocol's own limit. */
export const MAX_TRANSACTION_BYTES = 16 * 1024;

/** An output as the policy reads it, from the transaction or from the chain: address, value, the credentials behind the address and what else it carries. */
export interface ParsedOutput {
  address: string;
  lovelace: bigint;
  assets: AssetAmounts;
  paymentCredential: Credential | undefined;
  stakeCredential: Credential | undefined;
  hasDatum: boolean;
  hasReferenceScript: boolean;
  /** The Plutus language of the reference script the output carries, or undefined when it carries none or a native one. */
  referenceScriptLanguage: PlutusLanguageVersion | undefined;
  /**
   * The 28 byte script hash the first field of the output's inline datum
   * names, when it carries one shaped that way. An account's control
   * UTxO names there the logic script its rules live in, which is the
   * only field of the state the account validator reads.
   */
  logicHash: string | undefined;
}

/**
 * A certificate as the policy reads it: its kind, the stake credential it
 * acts on when it acts on one, every credential it names at all (stake,
 * DRep, committee, pool operator, pool owners and reward account, since
 * each of those may have to sign), and the deposit it carries when explicit.
 */
export interface ParsedCertificate {
  kind: string;
  credential: Credential | undefined;
  credentials: Credential[];
  deposit: bigint | undefined;
}

/** A voter of a voting procedure: the role it votes in and the credential that must sign for it. */
export interface ParsedVoter {
  kind: string;
  credential: Credential;
}

/** The execution budget a redeemer declares. */
export interface ExecutionBudget {
  memory: bigint;
  steps: bigint;
}

/** A withdrawal: the reward account it draws from, that account's credential, and the lovelace. */
export interface ParsedWithdrawal {
  rewardAddress: string;
  credential: Credential | undefined;
  lovelace: bigint;
}

/** A redeemer: what it is for, which item of that kind it belongs to, and the budget it declares. */
export interface ParsedRedeemer {
  purpose: string;
  index: number;
  executionUnits: ExecutionBudget;
}

/** A Plutus script witness attached to the transaction, by its hash. */
export interface ParsedScript {
  hash: string;
  language: string;
}

/** Everything the policy reads from a transaction. */
export interface ParsedTransaction {
  cbor: string;
  hash: string;
  size: number;
  inputs: TxIn[];
  referenceInputs: TxIn[];
  outputs: ParsedOutput[];
  fee: bigint;
  mint: AssetAmounts;
  certificates: ParsedCertificate[];
  withdrawals: ParsedWithdrawal[];
  voters: ParsedVoter[];
  collateralInputs: TxIn[];
  collateralReturn: ParsedOutput | undefined;
  totalCollateral: bigint | undefined;
  requiredSigners: string[];
  /** The script data hash the body commits to, when the body carries one. */
  scriptDataHash: string | undefined;
  scripts: ParsedScript[];
  nativeScriptCount: number;
  redeemers: ParsedRedeemer[];
  /** The phase two flag: false marks a transaction whose scripts are expected to fail, which forfeits the collateral. */
  isValid: boolean;
  /** The validity upper bound: the first slot the transaction is no longer valid at, when the body sets one. */
  invalidHereafter: bigint | undefined;
}

/** An input of the transaction paired with the output it spends, when the chain knows it. */
export interface ResolvedInput {
  input: TxIn;
  ref: string;
  output: ParsedOutput | undefined;
}

/** What parsing yields: the transaction, or the reason it is not well formed. */
export type ParseResult = { transaction: ParsedTransaction; violation?: never } | { transaction?: never; violation: Violation };

/** What resolving yields: every input and every reference input paired with the output it names, or the reason the chain could not be asked. */
export type ResolveResult =
  | { inputs: ResolvedInput[]; referenceInputs: ResolvedInput[]; violation?: never }
  | { inputs?: never; referenceInputs?: never; violation: Violation };

/** The scalar shapes of the CIP-116 view: hex strings, 28 byte hashes and integers carried as decimal strings. */
const hex = z.string().regex(/^[0-9a-f]*$/);
const hash28 = hex.length(56);
const integer = z.string().regex(/^-?[0-9]+$/);

/** The parts of the view the policy reads, each left loose so a field it does not read never fails the parse. */
const inputSchema = z.object({ transaction_id: hex.length(64), index: z.coerce.number().int().min(0) });
const amountSchema = z.object({ coin: integer, assets: z.record(hash28, z.record(hex, integer)).optional() });
const scriptRefSchema = z.object({ value: z.object({ language: z.string() }).loose().optional() }).loose();
const outputSchema = z
  .object({ address: z.string(), amount: amountSchema, plutus_data: z.unknown().optional(), script_ref: z.unknown().optional() })
  .loose();
const credentialSchema = z.object({ tag: z.enum(['pubkey_hash', 'script_hash']), value: hash28 });
const datumFieldSchema = z.object({ tag: z.string(), value: z.unknown().optional() }).loose();
const inlineDatumSchema = z
  .object({ tag: z.literal('datum'), value: z.object({ tag: z.literal('constr'), alternative: z.literal('0'), data: z.array(datumFieldSchema) }).loose() })
  .loose();
const poolParametersSchema = z.object({ operator: z.string(), reward_account: z.string(), pool_owners: z.array(hash28) }).loose();
const certificateSchema = z
  .object({
    tag: z.string(),
    credential: credentialSchema.optional(),
    drep_credential: credentialSchema.optional(),
    committee_cold_credential: credentialSchema.optional(),
    committee_hot_credential: credentialSchema.optional(),
    pool_params: poolParametersSchema.optional(),
    pool_keyhash: z.string().optional(),
    coin: integer.optional(),
  })
  .loose();
const withdrawalSchema = z.object({ key: z.string(), value: integer });
const voterSchema = z.object({ tag: z.string(), credential: credentialSchema.optional(), pubkey_hash: hash28.optional() }).loose();
const votingProcedureSchema = z.object({ key: voterSchema }).loose();
const mintSchema = z.object({ script_hash: hash28, assets: z.record(hex, integer) });
const executionUnitsSchema = z.object({ mem: integer, steps: integer });
const redeemerSchema = z.object({ tag: z.string(), index: z.coerce.number().int().min(0), ex_units: executionUnitsSchema }).loose();
const plutusScriptSchema = z.object({ language: z.string(), bytes: hex });

/** The fields of a transaction body the policy reads, each left loose so a field it does not read never fails the parse. */
const bodySchema = z
  .object({
    inputs: z.array(inputSchema),
    outputs: z.array(outputSchema),
    fee: integer,
    ttl: integer.optional(),
    certs: z.array(certificateSchema).optional(),
    withdrawals: z.array(withdrawalSchema).optional(),
    voting_procedures: z.array(votingProcedureSchema).optional(),
    mint: z.array(mintSchema).optional(),
    collateral: z.array(inputSchema).optional(),
    required_signers: z.array(hash28).optional(),
    script_data_hash: hex.length(64).optional(),
    collateral_return: outputSchema.optional(),
    total_collateral: integer.optional(),
    reference_inputs: z.array(inputSchema).optional(),
    proposal_procedures: z.array(z.unknown()).optional(),
    donation: integer.optional(),
  })
  .loose();

/** The parts of a witness set the policy reads: the scripts and redeemers, which say what runs and with what budget. */
const witnessSetSchema = z
  .object({
    native_scripts: z.array(z.unknown()).optional(),
    plutus_scripts: z.array(plutusScriptSchema).optional(),
    redeemers: z.array(redeemerSchema).optional(),
  })
  .loose();

/** The parts of the CIP-116 view of a transaction the policy reads; anything else is carried along unread. */
const transactionSchema = z.object({ body: bodySchema, witness_set: witnessSetSchema, is_valid: z.boolean().default(true) }).loose();

/** The view's own shapes, as the schemas above read them. */
type InspectedOutput = z.infer<typeof outputSchema>;
type InspectedInput = z.infer<typeof inputSchema>;
type InspectedCredential = z.infer<typeof credentialSchema>;
type InspectedCertificate = z.infer<typeof certificateSchema>;
type InspectedVoter = z.infer<typeof voterSchema>;
type InspectedRedeemer = z.infer<typeof redeemerSchema>;

/** The Plutus language of a script witness, by the name the CIP-116 view gives it. */
const PLUTUS_LANGUAGES: Record<string, PlutusLanguageVersion> = {
  plutus_v1: Cometa.PlutusLanguageVersion.V1,
  plutus_v2: Cometa.PlutusLanguageVersion.V2,
  plutus_v3: Cometa.PlutusLanguageVersion.V3,
};

/**
 * The Plutus language of the reference script an output carries, as the
 * CIP-116 view presents it; an output carrying none, or carrying a
 * native script, is written in no Plutus language.
 */
const inspectedScriptLanguage = (scriptRef: unknown): PlutusLanguageVersion | undefined => {
  const parsed = scriptRefSchema.safeParse(scriptRef);
  const language = parsed.success ? parsed.data.value?.language : undefined;
  return language === undefined ? undefined : PLUTUS_LANGUAGES[language];
};

/** The purpose a redeemer serves, by the name the CIP-116 view gives it; a provider names the same purposes as cometa does. */
const REDEEMER_PURPOSES: Record<string, RedeemerPurpose> = {
  spend: Cometa.RedeemerPurpose.spend,
  mint: Cometa.RedeemerPurpose.mint,
  cert: Cometa.RedeemerPurpose.certificate,
  reward: Cometa.RedeemerPurpose.withdrawal,
  voting: Cometa.RedeemerPurpose.vote,
  proposing: Cometa.RedeemerPurpose.propose,
};

/** The Plutus language a script witness is labelled with; a label the policy does not know cannot be hashed and is refused. */
export const plutusLanguageOf = (label: string): PlutusLanguageVersion => {
  const language = PLUTUS_LANGUAGES[label];
  if (language === undefined) {
    throw new Error(`A script witness carries the unknown Plutus language ${label}`);
  }
  return language;
};

/**
 * The credential a Shelley address pays to, at a base, enterprise or
 * pointer address, or undefined for an address form without one, such as
 * a Byron or a reward address, which the policy cannot classify.
 */
export const paymentCredentialOf = (address: string): Credential | undefined => {
  const parsed = Cometa.Address.fromString(address);
  return (
    parsed.asBase()?.getPaymentCredential() ??
    parsed.asEnterprise()?.getCredential() ??
    parsed.asPointer()?.getPaymentCredential() ??
    undefined
  );
};

/** The stake credential of an address: the stake part of a base address, or the credential of a reward address. */
const stakeCredentialOf = (address: string): Credential | undefined => {
  const parsed = Cometa.Address.fromString(address);
  return parsed.asBase()?.getStakeCredential() ?? parsed.asReward()?.getCredential() ?? undefined;
};

/** The hex length of a 28 byte script hash, which is what a control datum names as its logic. */
const SCRIPT_HASH_HEX_LENGTH = 56;

/**
 * The script hash the first field of an inline datum names, as the
 * CIP-116 view of a transaction output presents the datum: a byte string
 * of 28 bytes in the first field of the first constructor. A datum of any
 * other shape, a datum hash and an output with no datum name none.
 */
const inlineLogicHash = (data: unknown): string | undefined => {
  const parsed = inlineDatumSchema.safeParse(data);
  const first = parsed.success ? parsed.data.value.data[0] : undefined;
  return first?.tag === 'bytes' && typeof first.value === 'string' && first.value.length === SCRIPT_HASH_HEX_LENGTH && hash28.safeParse(first.value).success
    ? first.value
    : undefined;
};

/** The same first field, read off an inline datum as the chain reports it. */
const datumLogicHash = (datum: PlutusData | undefined): string | undefined => {
  if (datum === undefined || !Cometa.isPlutusDataConstr(datum) || datum.constructor !== 0n) {
    return undefined;
  }
  const first = datum.fields.items[0];
  if (first === undefined || !Cometa.isPlutusDataByteArray(first)) {
    return undefined;
  }
  const hash = Cometa.uint8ArrayToHex(first);
  return hash.length === SCRIPT_HASH_HEX_LENGTH ? hash : undefined;
};

/** The `txHash#index` reference of an input. */
const inputRef = (input: TxIn): string => utxoRef(input.txId, input.index);

/** The asset amounts of a value as the policy keeps them: asset id to quantity. */
const toAssets = (assets: Record<string, Record<string, string>> | undefined): AssetAmounts => {
  const amounts: AssetAmounts = {};
  for (const [policyId, names] of Object.entries(assets ?? {})) {
    for (const [name, quantity] of Object.entries(names)) {
      amounts[`${policyId}${name}`] = BigInt(quantity);
    }
  }
  return amounts;
};

/** An input as cometa names it. */
const toInput = (input: InspectedInput): TxIn => ({ txId: input.transaction_id, index: input.index });

/** A credential as cometa names it, or undefined when the view names none. */
const toCredential = (credential: InspectedCredential | undefined): Credential | undefined =>
  credential === undefined
    ? undefined
    : {
        hash: credential.value,
        type: credential.tag === 'script_hash' ? Cometa.CredentialType.ScriptHash : Cometa.CredentialType.KeyHash,
      };

/** The key hash credential of a key. */
const keyCredential = (hash: string): Credential => ({ hash, type: Cometa.CredentialType.KeyHash });

/** The key hash behind a pool id, which the view gives in bech32 form. */
const poolKeyHash = (poolId: string): string => (/^[0-9a-f]{56}$/.test(poolId) ? poolId : Cometa.Bech32.decode(poolId).hex);

/** An output of the transaction, with the credentials behind its address read out. */
const toOutput = (output: InspectedOutput): ParsedOutput => ({
  address: output.address,
  lovelace: BigInt(output.amount.coin),
  assets: toAssets(output.amount.assets),
  paymentCredential: paymentCredentialOf(output.address),
  stakeCredential: stakeCredentialOf(output.address),
  hasDatum: output.plutus_data !== undefined,
  hasReferenceScript: output.script_ref !== undefined,
  referenceScriptLanguage: inspectedScriptLanguage(output.script_ref),
  logicHash: inlineLogicHash(output.plutus_data),
});

/** A certificate with every credential it names collected, so that no certificate kind can name a signer the policy does not see. */
const toCertificate = (certificate: InspectedCertificate): ParsedCertificate => {
  const credential = toCredential(certificate.credential);
  const named: (Credential | undefined)[] = [
    credential,
    toCredential(certificate.drep_credential),
    toCredential(certificate.committee_cold_credential),
    toCredential(certificate.committee_hot_credential),
  ];
  if (certificate.pool_params !== undefined) {
    named.push(
      keyCredential(poolKeyHash(certificate.pool_params.operator)),
      stakeCredentialOf(certificate.pool_params.reward_account),
      ...certificate.pool_params.pool_owners.map(keyCredential),
    );
  }
  if (certificate.pool_keyhash !== undefined) {
    named.push(keyCredential(poolKeyHash(certificate.pool_keyhash)));
  }
  return {
    kind: certificate.tag,
    credential,
    credentials: named.filter((entry): entry is Credential => entry !== undefined),
    deposit: certificate.coin === undefined ? undefined : BigInt(certificate.coin),
  };
};

/** The voter of a voting procedure; a voter the view gives no credential for cannot be checked and is refused. */
const toVoter = (voter: InspectedVoter): ParsedVoter => {
  const credential = toCredential(voter.credential) ?? (voter.pubkey_hash === undefined ? undefined : keyCredential(voter.pubkey_hash));
  if (credential === undefined) {
    throw new Error(`A ${voter.tag} voter names no credential`);
  }
  return { kind: voter.tag, credential };
};

/** A redeemer with its purpose named as cometa names it, so that evaluation results can be matched to it. */
const toRedeemer = (redeemer: InspectedRedeemer): ParsedRedeemer => ({
  purpose: REDEEMER_PURPOSES[redeemer.tag] ?? redeemer.tag,
  index: redeemer.index,
  executionUnits: { memory: BigInt(redeemer.ex_units.mem), steps: BigInt(redeemer.ex_units.steps) },
});

/** An output as the chain reports it, in the shape the policy reads. */
const toParsedOutput = (output: TxOut): ParsedOutput => ({
  address: output.address,
  lovelace: output.value.coins,
  assets: { ...(output.value.assets ?? {}) },
  paymentCredential: paymentCredentialOf(output.address),
  stakeCredential: stakeCredentialOf(output.address),
  hasDatum: output.datum !== undefined || output.datumHash !== undefined,
  hasReferenceScript: output.scriptReference !== undefined,
  referenceScriptLanguage:
    output.scriptReference !== undefined && Cometa.isPlutusScript(output.scriptReference) ? output.scriptReference.version : undefined,
  logicHash: datumLogicHash(output.datum),
});

/** A refusal under the first rule. */
const wellFormedViolation = (detail: string): ParseResult => ({ violation: { rule: 'well_formed', detail } });

/** What a transaction carries that no account transaction does, when it carries either: proposal procedures or a treasury donation. */
const unneededGovernance = (body: Pick<z.infer<typeof bodySchema>, 'proposal_procedures' | 'donation'>): string | undefined =>
  (body.proposal_procedures ?? []).length > 0 ? 'proposal procedures' : body.donation === undefined ? undefined : 'a treasury donation';

/**
 * Reads a transaction out of its CBOR hex. The size is checked first so
 * that nothing larger than the protocol allows is ever decoded. The
 * transaction is then decoded by cometa into its CIP-116 view, and the
 * fields the policy reads are checked against a schema, so that a view
 * missing or misshaping any of them is refused rather than read as empty.
 * Proposal procedures and treasury donations are refused outright: no
 * account transaction carries them, and a proposal's guardrails script
 * would run without appearing anywhere the script rules look.
 */
export const parseTransaction = (cbor: string): ParseResult => {
  if (!/^([0-9a-fA-F]{2})+$/.test(cbor)) {
    return wellFormedViolation('The transaction is not a hex encoded CBOR byte string');
  }
  const size = cbor.length / 2;
  if (size > MAX_TRANSACTION_BYTES) {
    return wellFormedViolation(`The transaction is ${size} bytes, over the ${MAX_TRANSACTION_BYTES} byte limit`);
  }
  const normalised = cbor.toLowerCase();
  let inspected: unknown;
  let hash: string;
  try {
    inspected = Cometa.inspectTx(normalised);
    hash = transactionHash(normalised);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return wellFormedViolation(`The transaction does not decode as a Conway transaction: ${message}`);
  }
  const result = transactionSchema.safeParse(inspected);
  if (!result.success) {
    const issue = result.error.issues[0];
    return wellFormedViolation(`The transaction view is missing or misshapes ${issue?.path.join('.') || 'a field'}: ${issue?.message ?? 'invalid'}`);
  }
  const { body, witness_set: witnessSet, is_valid: isValid } = result.data;
  const unneeded = unneededGovernance(body);
  if (unneeded !== undefined) {
    return wellFormedViolation(`The transaction carries ${unneeded}; account transactions carry neither proposal procedures nor a treasury donation`);
  }
  let transaction: ParsedTransaction;
  try {
    transaction = {
      cbor: normalised,
      hash,
      size,
      inputs: body.inputs.map(toInput),
      referenceInputs: (body.reference_inputs ?? []).map(toInput),
      outputs: body.outputs.map(toOutput),
      fee: BigInt(body.fee),
      mint: toAssets(Object.fromEntries((body.mint ?? []).map((entry) => [entry.script_hash, entry.assets]))),
      certificates: (body.certs ?? []).map(toCertificate),
      withdrawals: (body.withdrawals ?? []).map((withdrawal) => ({
        rewardAddress: withdrawal.key,
        credential: stakeCredentialOf(withdrawal.key),
        lovelace: BigInt(withdrawal.value),
      })),
      voters: (body.voting_procedures ?? []).map((procedure) => toVoter(procedure.key)),
      collateralInputs: (body.collateral ?? []).map(toInput),
      collateralReturn: body.collateral_return === undefined ? undefined : toOutput(body.collateral_return),
      totalCollateral: body.total_collateral === undefined ? undefined : BigInt(body.total_collateral),
      requiredSigners: body.required_signers ?? [],
      scriptDataHash: body.script_data_hash,
      scripts: (witnessSet.plutus_scripts ?? []).map((script) => ({
        language: script.language,
        hash: Cometa.computeScriptHash({
          type: Cometa.ScriptType.Plutus,
          bytes: script.bytes,
          version: plutusLanguageOf(script.language),
        }),
      })),
      nativeScriptCount: (witnessSet.native_scripts ?? []).length,
      redeemers: (witnessSet.redeemers ?? []).map(toRedeemer),
      isValid,
      invalidHereafter: body.ttl === undefined ? undefined : BigInt(body.ttl),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return wellFormedViolation(`The transaction carries a value the policy cannot read: ${message}`);
  }
  return { transaction };
};

/**
 * Looks up the outputs the transaction spends and the ones it references
 * through the provider, in one call, so that every input can be
 * classified by the address and value it holds and a referenced control
 * UTxO can be read for the account it belongs to. An input the chain does
 * not know keeps an undefined output; the policy refuses such a
 * transaction at evaluation, since no node could run it. A provider that
 * refuses the whole lookup is not asked again input by input, which would
 * let a client turn one request into as many provider calls as a
 * transaction has inputs; the transaction is refused at evaluation
 * instead.
 */
export const resolveInputs = async (provider: Provider, inputs: TxIn[], referenceInputs: TxIn[] = []): Promise<ResolveResult> => {
  const wanted = [...inputs, ...referenceInputs];
  let resolved: UTxO[] = [];
  try {
    resolved = wanted.length === 0 ? [] : await provider.resolveUnspentOutputs(wanted);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { violation: { rule: 'evaluates', detail: `The inputs could not be resolved: ${message}` } };
  }
  const resolve = (input: TxIn): ResolvedInput => {
    const ref = inputRef(input);
    const utxo = resolved.find((candidate) => inputRef(candidate.input) === ref);
    return { input, ref, output: utxo === undefined ? undefined : toParsedOutput(utxo.output) };
  };
  return { inputs: inputs.map(resolve), referenceInputs: referenceInputs.map(resolve) };
};
