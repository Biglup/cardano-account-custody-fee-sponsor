import type Database from 'better-sqlite3';
import type { Provider, VkeyWitnessSet } from '@biglup/cometa';
import type { Logger } from 'pino';
import { recordAudit } from './audit.js';
import { Cometa } from './cometa.js';
import type { Config } from './config.js';
import {
  InvalidTransactionError,
  LeaseConsumedError,
  LeaseExpiredError,
  LeaseReleasedError,
  QuotaExceededError,
  type ServiceError,
  UnknownLeaseError,
} from './http/errors.js';
import type { ApiKey } from './keys.js';
import { type ParsedTransaction, parseTransaction, resolveInputs } from './policy/parse.js';
import { type PolicyApproval, type PolicyContext, type PolicyMode, type Violation, applyPolicy } from './policy/rules.js';
import type { SharedCollateral } from './pool/collateral.js';
import type { Lease, LeaseService } from './pool/leases.js';
import { type PoolUtxo, parseUtxoRef } from './pool/utxo.js';
import { WitnessRecordedError, type WitnessStore } from './pool/witnesses.js';
import type { ServiceWallet } from './wallet.js';

/** The witness set issued for a lease, as the API returns it. */
export interface IssuedWitness {
  leaseId: string;
  witnessSet: string;
}

/** The witness set issued in collateral mode, as the API returns it: keyed by the transaction it signs. */
export interface IssuedCollateralWitness {
  txHash: string;
  witnessSet: string;
}

/** The witness service: checks a client's transaction against the policy and signs for the sponsor. */
export interface WitnessService {
  /** Issues the lease's witness set for the transaction, or refuses it naming the rule that failed. */
  issue(apiKey: ApiKey, leaseId: string, transaction: string): Promise<IssuedWitness>;
  /** Issues the sponsor's collateral signature for a transaction that spends no sponsor input, or refuses it naming the rule that failed. */
  issueCollateral(apiKey: ApiKey, transaction: string): Promise<IssuedCollateralWitness>;
}

/** The tunables the policy depends on. */
export type WitnessSettings = Pick<
  Config,
  'accountScriptHash' | 'maxSponsoredLovelace' | 'maxFeeLovelace' | 'validityMarginSeconds' | 'collateralValiditySeconds' | 'slots'
>;

/** Everything the witness service needs injected; `now` lets tests move the clock the validity bounds are measured against. */
export interface WitnessServiceDependencies {
  db: Database.Database;
  provider: Provider;
  serviceWallet: ServiceWallet;
  leases: LeaseService;
  witnesses: WitnessStore;
  collateral: SharedCollateral;
  settings: WitnessSettings;
  now?: () => Date;
  logger?: Logger;
}

/** The CBOR map key of the verification key witnesses within a transaction witness set. */
const VKEY_WITNESSES_KEY = 0;

/** The length in bytes of a key hash. */
const KEY_HASH_BYTES = 28;

/** The hash of a verification key, as a credential names it. */
const keyHashOf = (vkey: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(vkey), KEY_HASH_BYTES));

/**
 * The CBOR of a transaction witness set holding only verification key
 * witnesses, which is what a client appends to its transaction.
 */
const encodeVkeyWitnessSet = (witnesses: VkeyWitnessSet): string => {
  const writer = new Cometa.CborWriter();
  writer.startMap(1).writeUnsignedInt(VKEY_WITNESSES_KEY).startArray(witnesses.length);
  for (const witness of witnesses) {
    writer.startArray(2).writeByteString(Cometa.hexToUint8Array(witness.vkey)).writeByteString(Cometa.hexToUint8Array(witness.signature));
  }
  return writer.encodeHex();
};

/** What a request is about on the audit trail: the lease it names in fee mode, or the collateral mode itself. */
type Subject = { leaseId: string } | { mode: 'collateral' };

/** What signing a transaction that passed the policy produced: the witness set and the verdict it was signed under. */
interface Signed {
  witnessSet: string;
  verdict: PolicyApproval;
}

/**
 * Creates the witness service. A request in fee mode walks the lease
 * state machine first: an unknown lease is refused, an expired or
 * released one too, and a consumed one answers with the witness set it
 * already issued when the transaction is the same, or refuses a different
 * one; each of these refusals is written to the audit trail under the
 * lease's state. A request in collateral mode names no lease; the
 * transaction it presents is answered with the witness set already
 * issued for it when there is one. Either way the transaction is parsed,
 * the key's hourly witness quota checked, its inputs resolved through the
 * provider and the policy applied in rule order under the mode; only a
 * transaction that passes every rule, and whose sponsored lovelace fits
 * in what the key's daily quota still allows, is signed. Both quotas
 * count witnesses actually issued, so a witness set answered again for
 * the same transaction counts once; the store measures them, here ahead
 * of the provider calls so a key over quota costs nothing, and again in
 * the step that records the witness, where the bound is final. The wallet
 * signs with every key of its own the transaction asks for, so the
 * witness set it returns is checked to be the sponsor payment key's
 * signature and nothing else before it leaves; anything more is refused
 * as if the policy had caught it. A lease is consumed in the same step
 * that records the witness; a lease found consumed by then, as when two
 * requests race, answers the witness set already recorded when the
 * transaction is the same, as does a collateral mode transaction found
 * recorded by then. Every decision is written to the audit trail with the
 * transaction hash, never its body.
 */
export const createWitnessService = ({
  db,
  provider,
  serviceWallet,
  leases,
  witnesses,
  collateral,
  settings,
  now = () => new Date(),
  logger,
}: WitnessServiceDependencies): WitnessService => {
  const knowsUtxo = db.prepare('SELECT 1 FROM pool_utxos WHERE tx_hash = ? AND tx_index = ?');

  /** What the policy knows when it checks a transaction under the mode against the shared collateral, as of now. */
  const policyContext = (mode: PolicyMode, shared: PoolUtxo): PolicyContext => ({
    sponsor: { address: serviceWallet.address, paymentKeyHash: serviceWallet.paymentKeyHash, stakeKeyHash: serviceWallet.stakeKeyHash },
    accountScriptHash: settings.accountScriptHash,
    mode,
    collateral: shared,
    limits: {
      maxSponsoredLovelace: settings.maxSponsoredLovelace,
      maxFeeLovelace: settings.maxFeeLovelace,
      validityMarginSeconds: settings.validityMarginSeconds,
      collateralValiditySeconds: settings.collateralValiditySeconds,
    },
    slots: settings.slots,
    now: now(),
    isSponsorUtxo: (ref) => {
      const { txHash, index } = parseUtxoRef(ref);
      return knowsUtxo.get(txHash, index) !== undefined;
    },
  });

  /** Refuses the transaction under a policy rule and records the refusal; nothing the client holds changes. */
  const refuse = (apiKey: ApiKey, subject: Subject, txHash: string | undefined, violation: Violation): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: violation.rule,
      detail: { ...subject, txHash: txHash ?? null, rule: violation.rule, reason: violation.detail },
    });
    throw new InvalidTransactionError(violation.rule, violation.detail);
  };

  /** Records a refusal under a quota and rethrows it; nothing the client holds changes. */
  const refuseQuota = (apiKey: ApiKey, subject: Subject, txHash: string, error: QuotaExceededError): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: error.code,
      detail: { ...subject, txHash, quota: error.quota, reason: error.detail },
    });
    throw error;
  };

  /** The key may still obtain a witness, sponsoring `sponsoredLovelace` once the policy has established it. */
  const checkQuotas = (apiKey: ApiKey, subject: Subject, txHash: string, sponsoredLovelace?: bigint): void => {
    const shortfall = witnesses.quotaShortfall(apiKey, sponsoredLovelace === undefined ? undefined : Number(sponsoredLovelace));
    if (shortfall !== undefined) {
      refuseQuota(apiKey, subject, txHash, new QuotaExceededError(shortfall.quota, shortfall.detail));
    }
  };

  /** The audit outcome a refusal by the lease's state is recorded under: the state itself, or the error's own code. */
  const leaseOutcome = (error: ServiceError): string => {
    if (error instanceof LeaseReleasedError) {
      return 'lease_released';
    }
    if (error instanceof LeaseExpiredError) {
      return 'lease_expired';
    }
    if (error instanceof LeaseConsumedError) {
      return 'lease_consumed';
    }
    return error.code;
  };

  /** Records a refusal by the lease's state, or by a shortage of the service's own, and rethrows it; nothing changes. */
  const refuseWith = (apiKey: ApiKey, subject: Subject, txHash: string | undefined, error: ServiceError): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: leaseOutcome(error),
      detail: { ...subject, txHash: txHash ?? null, reason: error.detail ?? error.code },
    });
    throw error;
  };

  /** The shared collateral, or the audited refusal when the pool holds none. */
  const requireCollateral = async (apiKey: ApiKey, subject: Subject, txHash: string): Promise<PoolUtxo> => {
    try {
      return await collateral.require();
    } catch (err) {
      return refuseWith(apiKey, subject, txHash, err as ServiceError);
    }
  };

  /**
   * Resolves the inputs, applies the policy under the mode and signs,
   * checking that the signature is the sponsor payment key's alone;
   * answers the first violation found instead when there is one.
   */
  const sign = async (tx: ParsedTransaction, mode: PolicyMode, shared: PoolUtxo): Promise<Signed | Violation> => {
    const resolved = await resolveInputs(provider, tx.inputs);
    if (resolved.violation !== undefined) {
      return resolved.violation;
    }
    const verdict = await applyPolicy(tx, resolved.inputs, policyContext(mode, shared), provider);
    if (verdict.violation !== undefined) {
      return verdict.violation;
    }
    const produced = await serviceWallet.wallet.signTransaction(tx.cbor, true);
    const only = produced.length === 1 ? produced[0] : undefined;
    if (only === undefined || keyHashOf(only.vkey) !== serviceWallet.paymentKeyHash) {
      return { rule: 'signers', detail: `Signing produced ${produced.length} witnesses where only the sponsor payment key may sign` };
    }
    return { witnessSet: encodeVkeyWitnessSet(produced), verdict };
  };

  /** Whether what signing yielded is a violation rather than a witness set. */
  const isViolation = (outcome: Signed | Violation): outcome is Violation => 'rule' in outcome;

  /** The witness set a consumed lease already issued for this very transaction, or the refusal of a different one. */
  const reissue = (apiKey: ApiKey, leaseId: string, txHash: string): IssuedWitness => {
    const issued = witnesses.ofLease(leaseId);
    if (issued === undefined || issued.txHash !== txHash) {
      return refuseWith(apiKey, { leaseId }, txHash, new LeaseConsumedError(leaseId));
    }
    recordAudit(db, { apiKeyId: apiKey.id, action: 'witness', outcome: 'reissued', detail: { leaseId, txHash } });
    return { leaseId, witnessSet: issued.witnessSet };
  };

  /** The witness set already issued in collateral mode for the transaction, if one was. */
  const reissueCollateral = (apiKey: ApiKey, txHash: string): IssuedCollateralWitness | undefined => {
    const issued = witnesses.ofTransaction(txHash);
    if (issued === undefined || issued.leaseId !== undefined) {
      return undefined;
    }
    recordAudit(db, { apiKeyId: apiKey.id, action: 'witness', outcome: 'reissued', detail: { mode: 'collateral', txHash } });
    return { txHash, witnessSet: issued.witnessSet };
  };

  /** The lease the key holds under the id, or the audited refusal of an id it does not. */
  const findLease = (apiKey: ApiKey, leaseId: string): Lease => {
    try {
      return leases.find(apiKey, leaseId);
    } catch (err) {
      if (err instanceof UnknownLeaseError) {
        return refuseWith(apiKey, { leaseId }, undefined, err);
      }
      throw err;
    }
  };

  const issue = async (apiKey: ApiKey, leaseId: string, transaction: string): Promise<IssuedWitness> => {
    leases.expireStale();
    const subject: Subject = { leaseId };
    const lease = findLease(apiKey, leaseId);
    if (lease.status === 'expired') {
      return refuseWith(apiKey, subject, undefined, new LeaseExpiredError(leaseId));
    }
    if (lease.status === 'released') {
      return refuseWith(apiKey, subject, undefined, new LeaseReleasedError(leaseId));
    }

    const parsed = parseTransaction(transaction);
    if (parsed.violation !== undefined) {
      return refuse(apiKey, subject, undefined, parsed.violation);
    }
    const tx = parsed.transaction;

    if (lease.status === 'consumed') {
      return reissue(apiKey, leaseId, tx.hash);
    }

    checkQuotas(apiKey, subject, tx.hash);
    const shared = await requireCollateral(apiKey, subject, tx.hash);
    const signed = await sign(tx, { kind: 'fee', fee: lease.fee, expiresAt: lease.expiresAt }, shared);
    if (isViolation(signed)) {
      return refuse(apiKey, subject, tx.hash, signed);
    }
    checkQuotas(apiKey, subject, tx.hash, signed.verdict.sponsoredLovelace);

    const sponsoredLovelace = Number(signed.verdict.sponsoredLovelace);
    const invalidHereafter = Number(signed.verdict.invalidHereafter);
    try {
      leases.consume(apiKey, lease, { txHash: tx.hash, sponsoredLovelace, witnessSet: signed.witnessSet, invalidHereafter });
    } catch (err) {
      if (err instanceof LeaseConsumedError) {
        return reissue(apiKey, leaseId, tx.hash);
      }
      if (err instanceof LeaseExpiredError) {
        return refuseWith(apiKey, subject, tx.hash, err);
      }
      if (err instanceof QuotaExceededError) {
        return refuseQuota(apiKey, subject, tx.hash, err);
      }
      throw err;
    }
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: 'issued',
      detail: { leaseId, txHash: tx.hash, kind: signed.verdict.kind ?? null, sponsoredLovelace, fee: tx.fee.toString() },
    });
    logger?.info({ leaseId, txHash: tx.hash, kind: signed.verdict.kind, sponsoredLovelace }, 'Witness issued');
    return { leaseId, witnessSet: signed.witnessSet };
  };

  const issueCollateral = async (apiKey: ApiKey, transaction: string): Promise<IssuedCollateralWitness> => {
    const subject: Subject = { mode: 'collateral' };
    const parsed = parseTransaction(transaction);
    if (parsed.violation !== undefined) {
      return refuse(apiKey, subject, undefined, parsed.violation);
    }
    const tx = parsed.transaction;

    const already = reissueCollateral(apiKey, tx.hash);
    if (already !== undefined) {
      return already;
    }

    checkQuotas(apiKey, subject, tx.hash);
    const shared = await requireCollateral(apiKey, subject, tx.hash);
    const signed = await sign(tx, { kind: 'collateral' }, shared);
    if (isViolation(signed)) {
      return refuse(apiKey, subject, tx.hash, signed);
    }
    checkQuotas(apiKey, subject, tx.hash, signed.verdict.sponsoredLovelace);

    const sponsoredLovelace = Number(signed.verdict.sponsoredLovelace);
    const invalidHereafter = Number(signed.verdict.invalidHereafter);
    try {
      witnesses.record(apiKey, { txHash: tx.hash, leaseId: undefined, sponsoredLovelace, witnessSet: signed.witnessSet, invalidHereafter });
    } catch (err) {
      if (err instanceof WitnessRecordedError) {
        const recorded = reissueCollateral(apiKey, tx.hash);
        if (recorded !== undefined) {
          return recorded;
        }
      }
      if (err instanceof QuotaExceededError) {
        return refuseQuota(apiKey, subject, tx.hash, err);
      }
      throw err;
    }
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: 'issued',
      detail: { mode: 'collateral', txHash: tx.hash, kind: signed.verdict.kind ?? null, sponsoredLovelace, fee: tx.fee.toString() },
    });
    logger?.info({ mode: 'collateral', txHash: tx.hash, kind: signed.verdict.kind }, 'Witness issued');
    return { txHash: tx.hash, witnessSet: signed.witnessSet };
  };

  return { issue, issueCollateral };
};
