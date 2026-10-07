import type { Config } from '../config.js';

/** The pool sizes a UTxO is classified against and a split creates. */
export type PoolSizes = Pick<Config, 'feeUtxoLovelace' | 'collateralUtxoLovelace'>;

/**
 * The lovelace a split keeps back from the reserve beyond the outputs it
 * creates: enough for the fee of the largest transaction the network
 * accepts and for a change output above the minimum UTxO value.
 */
export const REPLENISH_FEE_MARGIN = 3_000_000n;

/** The least the reserve must hold for a split to create one output of `lovelace`. */
export const minimumSplitLovelace = (lovelace: number): bigint => BigInt(lovelace) + REPLENISH_FEE_MARGIN;
