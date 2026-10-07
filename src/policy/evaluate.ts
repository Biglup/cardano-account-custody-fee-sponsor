import type { Provider, Redeemer, UTxO } from '@biglup/cometa';
import type { ParsedRedeemer, ParsedTransaction, ResolvedInput } from './parse.js';
import type { LeasedUtxo, PolicyContext, Violation } from './rules.js';

/** A leased UTxO as a provider needs it to evaluate a transaction that spends it: at the sponsor address, holding lovelace only. */
const leasedUtxo = (utxo: LeasedUtxo, sponsorAddress: string): UTxO => ({
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

/**
 * The evaluation rule: every input must be known to the chain, the
 * provider must evaluate the transaction's scripts successfully with the
 * leased UTxOs supplied alongside, in case the provider's own view lags
 * behind the pool, and every declared budget must cover what the
 * evaluation found. A transaction that passes can only fail later in
 * phase one, which spends no collateral, so this is what protects the
 * leased collateral UTxO.
 */
export const evaluates = async (
  transaction: ParsedTransaction,
  inputs: ResolvedInput[],
  context: PolicyContext,
  provider: Provider,
): Promise<Violation | undefined> => {
  const unknown = inputs.find((input) => input.output === undefined);
  if (unknown !== undefined) {
    return { rule: 'evaluates', detail: `Input ${unknown.ref} is not an unspent output the chain knows` };
  }
  let evaluated: Redeemer[];
  try {
    evaluated = await provider.evaluateTransaction(transaction.cbor, [
      leasedUtxo(context.lease.fee, context.sponsor.address),
      leasedUtxo(context.lease.collateral, context.sponsor.address),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { rule: 'evaluates', detail: `The transaction does not evaluate: ${message}` };
  }
  return withinDeclaredBudget(transaction.redeemers, evaluated);
};
