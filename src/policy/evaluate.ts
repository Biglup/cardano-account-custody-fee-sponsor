import type { Provider, Redeemer, UTxO } from '@biglup/cometa';
import type { ParsedRedeemer, ParsedTransaction, ResolvedInput } from './parse.js';
import type { PolicyContext, SponsorUtxo, Violation } from './rules.js';

/** A sponsor UTxO as a provider needs it to evaluate a transaction that spends or declares it: at the sponsor address, holding lovelace only. */
const sponsorUtxo = (utxo: SponsorUtxo, sponsorAddress: string): UTxO => ({
  input: { txId: utxo.txHash, index: utxo.index },
  output: { address: sponsorAddress, value: { coins: BigInt(utxo.lovelace) } },
});

/**
 * Every redeemer the transaction declares has an evaluation result, and
 * the units that result says the script needs fit within the budget the
 * redeemer declares. A provider reports what each script needs whatever
 * the transaction declares, so a budget set below that would pass
 * evaluation here and still fail phase two on chain.
 */
const withinDeclaredBudget = (declared: ParsedRedeemer[], evaluated: Redeemer[]): Violation | undefined => {
  for (const redeemer of declared) {
    const name = `The ${redeemer.purpose} redeemer at index ${redeemer.index}`;
    const result = evaluated.find((candidate) => candidate.purpose === redeemer.purpose && candidate.index === redeemer.index);
    if (result === undefined) {
      return { rule: 'evaluates', detail: `${name} has no evaluation result` };
    }
    const needed = { memory: BigInt(result.executionUnits.memory), steps: BigInt(result.executionUnits.steps) };
    if (needed.memory > redeemer.executionUnits.memory || needed.steps > redeemer.executionUnits.steps) {
      return {
        rule: 'evaluates',
        detail: `${name} declares ${redeemer.executionUnits.memory} memory and ${redeemer.executionUnits.steps} steps but needs ${needed.memory} and ${needed.steps}`,
      };
    }
  }
  return undefined;
};

/** The sponsor UTxOs the transaction builds on under the mode: the leased fee UTxO when there is one, and the shared collateral. */
const sponsorUtxosOf = ({ mode, collateral, sponsor }: PolicyContext): UTxO[] => [
  ...(mode.kind === 'fee' ? [sponsorUtxo(mode.fee, sponsor.address)] : []),
  sponsorUtxo(collateral, sponsor.address),
];

/**
 * The evaluation rule: every input and every reference input must be
 * known to the chain, the provider must evaluate the transaction's
 * scripts successfully with the sponsor UTxOs supplied alongside, in case
 * the provider's own view lags behind the pool, and every declared budget
 * must cover what the evaluation found. A transaction that passes can
 * only fail later in phase one, which spends no collateral, so this is
 * what protects the shared collateral UTxO.
 */
export const evaluates = async (
  transaction: ParsedTransaction,
  inputs: ResolvedInput[],
  referenceInputs: ResolvedInput[],
  context: PolicyContext,
  provider: Provider,
): Promise<Violation | undefined> => {
  const unknown = inputs.find((input) => input.output === undefined);
  if (unknown !== undefined) {
    return { rule: 'evaluates', detail: `Input ${unknown.ref} is not an unspent output the chain knows` };
  }
  const unknownReference = referenceInputs.find((input) => input.output === undefined);
  if (unknownReference !== undefined) {
    return { rule: 'evaluates', detail: `Reference input ${unknownReference.ref} is not an unspent output the chain knows` };
  }
  let evaluated: Redeemer[];
  try {
    evaluated = await provider.evaluateTransaction(transaction.cbor, sponsorUtxosOf(context));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { rule: 'evaluates', detail: `The transaction does not evaluate: ${message}` };
  }
  return withinDeclaredBudget(transaction.redeemers, evaluated);
};
